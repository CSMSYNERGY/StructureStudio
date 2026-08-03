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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

  if (!res.ok) {
    // invalid_grant is the ONLY answer that means "this credential is dead". Everything
    // else is Intuit having a bad moment and must not cost the tenant a re-OAuth.
    const dead = res.status === 400 && /invalid_grant/i.test(bodyText);
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
    throw new QboTransient(`QuickBooks token refresh failed (${res.status}).`);
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
 */
export async function qboFetch(
  admin: any,
  clientId: string,
  realmId: string,
  path: string,
  init: RequestInit = {},
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
  if (!res.ok) {
    // Never surface the raw body: QuickBooks echoes customer data in validation errors.
    throw new QboTransient(`QuickBooks API ${res.status} on ${path.split("?")[0]}`);
  }
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

export { apiBase as qboApiBase };
