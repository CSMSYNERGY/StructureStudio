// providerTokens.ts — a usable access token for a Google or Microsoft connection row (341).
//
// The same rules Zoom's zoomAccess (meetingVideo.ts) follows, written once for the calendar
// providers. Zoom's own copy is left as it is: it is live and tested, and nothing here needs it.
//
//   * A token with more than a minute left is used as it is.
//   * Otherwise refresh, and STORE the rotated refresh token first (Microsoft rotates; Google
//     usually answers with none, which means "keep yours").
//   * invalid_grant on a healthy connection can be a race with another request that just
//     rotated it, so re-read the row before calling the connection dead. Dead = needs_reauth,
//     which the person's My connections card turns into "Reconnect".

import { type OAuthTokens, ProviderError } from "./providerHttp.ts";

// deno-lint-ignore no-explicit-any
type Admin = any;

export interface TokenConn {
  id: string;
  access_token: string | null;
  refresh_token: string | null;
  token_expires: string | null;
}

export async function providerAccess(
  admin: Admin,
  conn: TokenConn,
  refresh: (refreshToken: string) => Promise<OAuthTokens>,
  now: number,
  force = false,
): Promise<string> {
  if (!force && conn.access_token && conn.token_expires && Date.parse(conn.token_expires) > now + 60_000) {
    return conn.access_token;
  }
  if (!conn.refresh_token) throw new ProviderError("invalid_grant", 0, "No refresh token on the connection.");
  try {
    const t = await refresh(conn.refresh_token);
    const patch: Record<string, unknown> = {
      access_token: t.accessToken,
      token_expires: t.expiresAt,
      status: "connected",
      last_error: null,
      updated_at: new Date(now).toISOString(),
    };
    if (t.refreshToken) patch.refresh_token = t.refreshToken;
    const { error } = await admin.from("meeting_connections").update(patch).eq("id", conn.id);
    if (error) throw error;
    conn.access_token = t.accessToken;
    conn.token_expires = t.expiresAt;
    if (t.refreshToken) conn.refresh_token = t.refreshToken;
    return t.accessToken;
  } catch (e) {
    if (!(e instanceof ProviderError) || e.code !== "invalid_grant") throw e;
    const { data: fresh } = await admin.from("meeting_connections")
      .select("id, access_token, refresh_token, token_expires").eq("id", conn.id).maybeSingle();
    if (fresh && fresh.refresh_token && fresh.refresh_token !== conn.refresh_token &&
        fresh.access_token && fresh.token_expires && Date.parse(fresh.token_expires) > now + 60_000) {
      return fresh.access_token;
    }
    await admin.from("meeting_connections").update({
      status: "needs_reauth",
      access_token: null,
      last_error: "needs_reconnect",
      updated_at: new Date(now).toISOString(),
    }).eq("id", conn.id);
    throw e;
  }
}

/** One API call with the connection's token; on a 401, refresh once and try again. */
export async function withProvider<T>(
  admin: Admin,
  conn: TokenConn,
  refresh: (refreshToken: string) => Promise<OAuthTokens>,
  now: number,
  fn: (token: string) => Promise<T>,
): Promise<T> {
  const token = await providerAccess(admin, conn, refresh, now);
  try {
    return await fn(token);
  } catch (e) {
    if (!(e instanceof ProviderError) || e.code !== "unauthorized") throw e;
    return await fn(await providerAccess(admin, conn, refresh, now, true));
  }
}
