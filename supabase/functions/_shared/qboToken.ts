/**
 * QuickBooks Online access-token management.
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE: Intuit **rotates the refresh token on every
 * refresh**. The old one dies the moment a new pair is issued. So two concurrent refreshes
 * invalidate each other and the tenant is left with nothing — which is precisely how a live
 * BuildBridge credential died on 2026-07-28, silently, and needed a human to re-OAuth.
 *
 * Two defences:
 *   1. `qbo_claim_token_refresh` (migration 065) serialises the check-and-set behind an
 *      advisory lock, so N concurrent callers produce exactly ONE call to Intuit.
 *   2. PERSIST BEFORE USE — the new pair is written to the row BEFORE the token is handed
 *      to the caller. A crash after Intuit responds but before we save would otherwise
 *      throw away the only valid refresh token in existence.
 *
 * Failure polarity also matters. `invalid_grant` means Intuit has genuinely refused us:
 * mark the connection broken so the UI says "Reconnect". Anything else — a network blip, a
 * 5xx — releases the claim and throws transient. Marking those broken would force a
 * re-OAuth over a momentary outage.
 */

// deno-lint-ignore-file no-explicit-any

import { logEdgeError } from "./logError.ts";

const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

/** Sandbox and production share OAuth endpoints; only the API base differs. */
function apiBase(): string {
  return (Deno.env.get("QBO_API_BASE") ?? "https://quickbooks.api.intuit.com").replace(/\/+$/, "");
}

/** Read at REQUEST time, never at module top: a module-top read needs a redeploy to pick
 *  up a rotated secret, which cost us a debugging session on Deposyt. */
function clientCreds(): { id: string; secret: string } | null {
  const id = Deno.env.get("QBO_CLIENT_ID");
  const secret = Deno.env.get("QBO_CLIENT_SECRET");
  return id && secret ? { id, secret } : null;
}

export function qboOauthReady(): boolean {
  return clientCreds() !== null;
}

export class QboBroken extends Error {
  constructor(msg: string) { super(msg); this.name = "QboBroken"; }
}
export class QboNotConnected extends Error {
  constructor(msg = "QuickBooks is not connected for this account.") {
    super(msg); this.name = "QboNotConnected";
  }
}
export class QboTransient extends Error {
  constructor(msg: string) { super(msg); this.name = "QboTransient"; }
}

/**
 * A QuickBooks API call that answered non-OK.
 *
 * `tid` is Intuit's own trace id for the request (the `intuit_tid` response header). It is an
 * opaque correlation id carrying no customer data — which is exactly why it can be recorded
 * when the response BODY cannot. QuickBooks echoes customer fields into validation faults, so
 * the body has always been dropped here (see `qboFetch`), leaving failures that read
 * "QuickBooks API 400 on /invoice" with nothing whatsoever to act on. The tid is the first
 * thing Intuit support asks for, and it is the missing half of that deliberate decision.
 *
 * `permanent` answers "is a Retry pointless?". A ValidationFault fails identically forever —
 * a category mapped as an ItemRef, a malformed field — so offering a Retry is the same dead
 * end the disconnect-tombstone bug produced on 2026-08-03. Rate limits and 5xx are the
 * opposite: retrying IS the correct response. Claimed only on positive evidence; anything
 * ambiguous stays retryable, because a wrongly-permanent verdict strands a push that would
 * have succeeded, and that is the more expensive mistake.
 */
export class QboApiError extends Error {
  readonly status: number;
  readonly tid: string | null;
  readonly permanent: boolean;
  readonly faultType: string | null;
  readonly faultCode: string | null;
  constructor(init: {
    message: string;
    status: number;
    tid: string | null;
    permanent: boolean;
    faultType?: string | null;
    faultCode?: string | null;
  }) {
    super(init.message);
    this.name = "QboApiError";
    this.status = init.status;
    this.tid = init.tid;
    this.permanent = init.permanent;
    this.faultType = init.faultType ?? null;
    this.faultCode = init.faultCode ?? null;
  }
}

/** Intuit's per-request trace id. `Headers.get` is case-insensitive per the fetch spec, so the
 *  documented `intuit_tid` spelling also matches the `Intuit_Tid` casing seen in the wild. */
function tidOf(res: Response): string | null {
  const tid = res.headers.get("intuit_tid");
  return tid ? tid.slice(0, 100) : null;
}

/**
 * Pull ONLY the non-identifying parts of an Intuit fault: type, code, and element path.
 *
 * `Message` and especially `Detail` carry customer data ("Duplicate Name Exists in the table
 * … <customer name>"), so they are never read. Type ("ValidationFault"), code ("6000") and
 * element ("Line[0].SalesItemLineDetail.ItemRef") are enum-ish and safe to persist — they are
 * also the three fields that make a fault diagnosable without the body.
 */
function faultOf(body: string): { type: string | null; code: string | null; element: string | null } {
  try {
    const fault = (JSON.parse(body) as any)?.Fault;
    const first = Array.isArray(fault?.Error) ? fault.Error[0] : null;
    return {
      type: fault?.type ? String(fault.type).slice(0, 40) : null,
      code: first?.code ? String(first.code).slice(0, 20) : null,
      element: first?.element ? String(first.element).slice(0, 80) : null,
    };
  } catch {
    return { type: null, code: null, element: null };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The tenant's connection state — and the ONE test for "may we call QuickBooks".
 *
 * **`qbo_realm_id` alone is NOT a connection.** `disconnect_qbo` deliberately keeps the realm
 * id as a tombstone (it reserves the company under the partial unique index, and lets a
 * reconnect of the SAME books keep its item map) while nulling the tokens and
 * `qbo_connected_at`. So a guard written `if (!cs.qbo_realm_id) …` reads every DISCONNECTED
 * tenant as connected. That is not hypothetical: on 2026-08-03 a disconnect on
 * `structure-studio` left the tombstone standing, `list_qbo_items` sailed past its guard and
 * fell out of the token helper as an HTTP 400, and `pushQboInvoice` stayed live enough to
 * stamp "QuickBooks is not connected" onto invoices it was supposed to skip entirely.
 *
 * Connected means realm id AND `qbo_connected_at` — the same test `qbo_status` reports to the
 * portal, which is the point: four call sites disagreeing with the status card is what let the
 * bug hide. `realmId` is null unless connected, so a caller cannot reach for a tombstone.
 *
 * Deliberately does NOT select the tokens: nothing that only asks "are we connected?" should
 * be holding a credential it has no use for.
 */
export async function getQboConnection(admin: any, clientId: string): Promise<{
  realmId: string | null;
  connected: boolean;
  broken: boolean;
}> {
  const { data } = await admin.from("client_settings")
    .select("qbo_realm_id, qbo_connected_at, qbo_refresh_error")
    .eq("client_id", clientId).maybeSingle();
  const connected = !!data?.qbo_realm_id && !!data?.qbo_connected_at;
  return {
    realmId: connected ? String(data.qbo_realm_id) : null,
    connected,
    broken: connected && !!data?.qbo_refresh_error,
  };
}

async function releaseClaim(admin: any, clientId: string) {
  await admin.from("client_settings")
    .update({ qbo_refreshing_at: null })
    .eq("client_id", clientId);
}

/**
 * Exchange the refresh token for a new pair and persist it.
 * Returns the new access token. Caller must already hold the claim.
 */
async function refreshAtIntuit(admin: any, clientId: string, refreshToken: string): Promise<string> {
  const creds = clientCreds();
  if (!creds) {
    await releaseClaim(admin, clientId);
    throw new QboTransient("QuickBooks app credentials are not configured.");
  }

  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${creds.id}:${creds.secret}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
    });
  } catch (e) {
    // Could not even reach Intuit — nothing has been invalidated. Let go and retry later.
    await releaseClaim(admin, clientId);
    throw new QboTransient(`Could not reach QuickBooks: ${(e as Error).message}`);
  }

  const bodyText = await res.text();
  // Read before any branch: the OAuth endpoint returns a tid too, and a refresh failure is the
  // one QuickBooks error with no other trace at all. On 2026-08-03 working out which realm a
  // failed flow even belonged to needed a Supabase edge log — and this project's runtime log
  // stream is not reliably queryable (see CLAUDE.md), so "check the logs" is not a plan.
  const tid = tidOf(res);

  if (!res.ok) {
    // invalid_grant is the ONLY answer that means "this credential is dead". Everything
    // else is Intuit having a bad moment and must not cost the tenant a re-OAuth.
    const dead = res.status === 400 && /invalid_grant/i.test(bodyText);

    // app_errors, NOT the tenant-facing qbo_refresh_error: a trace id belongs in triage, not in
    // "Reconnect to restore syncing". Transient failures are logged too — they should be rare,
    // and a cluster of them is the signal that Intuit rather than this tenant is the problem.
    // Never the body: a token response echoes the credential on some error shapes.
    await logEdgeError({
      fn: "qbo-token-refresh",
      clientId,
      code: dead ? "qbo_refresh_invalid_grant" : `qbo_refresh_http_${res.status}`,
      message: dead
        ? "QuickBooks refused the saved refresh token (invalid_grant) — this tenant must reconnect."
        : `QuickBooks token refresh failed with HTTP ${res.status}.`,
      context: { status: res.status, intuit_tid: tid, dead },
    });

    if (dead) {
      await admin.from("client_settings").update({
        qbo_refresh_error: "QuickBooks refused the saved connection. Reconnect to restore syncing.",
        qbo_access_token: null,
        qbo_access_token_expires_at: null,
        qbo_refreshing_at: null,
      }).eq("client_id", clientId);
      throw new QboBroken("QuickBooks refused the saved connection.");
    }
    await releaseClaim(admin, clientId);
    throw new QboTransient(
      `QuickBooks token refresh failed (${res.status}).${tid ? ` [tid ${tid}]` : ""}`);
  }

  let tok: any;
  try { tok = JSON.parse(bodyText); } catch {
    await releaseClaim(admin, clientId);
    throw new QboTransient("QuickBooks returned an unreadable token response.");
  }

  const access = tok?.access_token;
  const newRefresh = tok?.refresh_token ?? refreshToken;
  if (!access) {
    await releaseClaim(admin, clientId);
    throw new QboTransient("QuickBooks returned no access token.");
  }

  const now = Date.now();
  // Absolute expiries. Intuit sends durations; storing those would be a clock bug waiting
  // to happen every time the row is read.
  const accessExp = new Date(now + (Number(tok.expires_in) || 3600) * 1000).toISOString();
  const refreshExp = new Date(now + (Number(tok.x_refresh_token_expires_in) || 8726400) * 1000).toISOString();

  // PERSIST BEFORE USE — see the header. The rotated refresh token must be durable before
  // this function returns, or a crash here strands the tenant.
  const { error } = await admin.from("client_settings").update({
    qbo_access_token: access,
    qbo_access_token_expires_at: accessExp,
    qbo_refresh_token: newRefresh,
    qbo_refresh_token_expires_at: refreshExp,
    qbo_token_refreshed_at: new Date(now).toISOString(),
    qbo_refresh_error: null,
    qbo_refreshing_at: null,
  }).eq("client_id", clientId);

  if (error) {
    // We hold a valid token we cannot store, and the OLD refresh token is now dead at
    // Intuit. Surfacing this loudly is the only honest option — returning the token would
    // work once and leave the tenant broken with no record of why.
    throw new QboTransient(`Refreshed QuickBooks but could not save the new token: ${error.message}`);
  }

  return access;
}

/**
 * Get a usable access token for this tenant, refreshing if needed.
 * Hot path (token still valid) costs one RPC and takes no locks.
 */
export async function getQboAccess(admin: any, clientId: string): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data, error } = await admin.rpc("qbo_claim_token_refresh", { p_client_id: clientId });
    if (error) throw new QboTransient(`Could not read the QuickBooks connection: ${error.message}`);

    const row = Array.isArray(data) ? data[0] : data;
    switch (row?.outcome) {
      case "fresh":         return row.token as string;
      case "claimed":       return await refreshAtIntuit(admin, clientId, row.token as string);
      case "not_connected": throw new QboNotConnected();
      case "broken":        throw new QboBroken("QuickBooks needs to be reconnected.");
      case "busy":          await sleep(400); continue;
      default:              throw new QboTransient("Unexpected QuickBooks connection state.");
    }
  }
  // Three rounds of `busy` means the holder is wedged; the 60s staleness window in the RPC
  // will let the next request take over rather than us forcing it here.
  throw new QboTransient("QuickBooks is busy refreshing its connection. Try again shortly.");
}

/**
 * Authenticated call to the QuickBooks API. One forced-refresh retry on a 401, because a
 * token can be revoked between our expiry check and the request landing.
 *
 * Failures throw `QboApiError`, which carries Intuit's `intuit_tid` and a permanent/transient
 * verdict. Successes can hand the tid back through the optional `meta` out-param.
 */
export async function qboFetch(
  admin: any,
  clientId: string,
  realmId: string,
  path: string,
  init: RequestInit = {},
  /** Optional out-param, for callers that want the trace id of a SUCCESSFUL call so it can be
   *  recorded next to whatever that call created. Deliberately an out-param rather than a change
   *  to the return type: every existing call site keeps working untouched, and a failure carries
   *  its own tid on the thrown QboApiError, so nothing needs this to diagnose an error. */
  meta?: { tid?: string | null; status?: number },
): Promise<any> {
  const url = `${apiBase()}/v3/company/${realmId}${path.startsWith("/") ? path : `/${path}`}`;

  const call = async (token: string) => fetch(url, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });

  let res = await call(await getQboAccess(admin, clientId));

  if (res.status === 401) {
    // Force the next getQboAccess to refresh rather than hand back the token we just saw
    // rejected. Clearing the expiry is enough — the RPC's freshness check then fails.
    await admin.from("client_settings")
      .update({ qbo_access_token_expires_at: null })
      .eq("client_id", clientId);
    res = await call(await getQboAccess(admin, clientId));
  }

  const text = await res.text();
  const tid = tidOf(res);
  if (meta) { meta.tid = tid; meta.status = res.status; }

  if (!res.ok) {
    // Never surface the raw body: QuickBooks echoes customer data in validation errors. The
    // fault's type/code/element and the tid are the safe substitutes — see faultOf/tidOf.
    const fault = faultOf(text);
    // A ValidationFault is Intuit saying the REQUEST is wrong, so an identical retry fails
    // identically; 403/404 likewise. Everything else stays retryable on purpose — a 429, a 5xx,
    // an unparsable body, or a second 401 that may just be an auth blip. Over-claiming
    // permanence would strand a push that would have gone through on the next attempt.
    const permanent = fault.type === "ValidationFault" || res.status === 403 || res.status === 404;
    const detail = [
      fault.type,
      fault.code ? `code ${fault.code}` : null,
      fault.element ? `at ${fault.element}` : null,
    ].filter(Boolean).join(" ");
    throw new QboApiError({
      message: `QuickBooks API ${res.status} on ${path.split("?")[0]}`
        + (detail ? ` — ${detail}` : "")
        + (tid ? ` [tid ${tid}]` : ""),
      status: res.status,
      tid,
      permanent,
      faultType: fault.type,
      faultCode: fault.code,
    });
  }
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

export { apiBase as qboApiBase };
