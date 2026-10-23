// zoomApi.ts — the Zoom half of "a fresh video link per booking" (migration 333).
//
// Every call Zoom needs, and nothing about our database: meetingVideo.ts owns the rows. Kept
// free of jsr:/npm: imports so _shared/zoomApi.test.ts runs in the offline test group, and
// `fetch` is injectable for the same reason.
//
// The app is a Zoom Marketplace "General app" with USER-managed OAuth: each team member
// authorises their own Zoom account, and the meeting is created as them (Carolyn 2026-10-23:
// "each team member"). Scopes: meeting:write:meeting (create/update/delete) and
// user:read:user (to show "Connected as jane@acme.com"). Secrets, added by Carolyn and never
// read or printed by an agent: ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET, ZOOM_WEBHOOK_SECRET_TOKEN.
//
// ⚠️ ZOOM ROTATES THE REFRESH TOKEN ON EVERY REFRESH, and the old one stops working. Whoever
// refreshes must store the new one before anything else can use the connection, and two
// requests refreshing at once means one of them gets `invalid_grant` with a perfectly healthy
// connection. meetingVideo.ts handles that race; this module just reports which it was.

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const ZOOM_AUTHORIZE_URL = "https://zoom.us/oauth/authorize";
const ZOOM_TOKEN_URL = "https://zoom.us/oauth/token";
const ZOOM_REVOKE_URL = "https://zoom.us/oauth/revoke";
const ZOOM_API = "https://api.zoom.us/v2";

/** A provider call that did not work, with a code we can store and show (never Zoom's text). */
export class ZoomError extends Error {
  constructor(
    /** 'invalid_grant' (connection gone) | 'unauthorized' | 'not_found' | 'rate_limited' |
     *  'provider_error' (5xx, network, timeout) | 'refused' (another 4xx). */
    public code: string,
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ZoomCreds {
  clientId: string;
  clientSecret: string;
}

/** Both secrets present? Before Carolyn adds them the feature is dark, not broken. */
export function zoomCredsFromEnv(get: (k: string) => string | undefined): ZoomCreds | null {
  const clientId = (get("ZOOM_CLIENT_ID") || "").trim();
  const clientSecret = (get("ZOOM_CLIENT_SECRET") || "").trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export function zoomAuthorizeUrl(creds: ZoomCreds, redirectUri: string, state: string): string {
  const u = new URL(ZOOM_AUTHORIZE_URL);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", creds.clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("state", state);
  return u.toString();
}

export interface ZoomTokens {
  accessToken: string;
  refreshToken: string;
  /** ISO instant the access token stops working. */
  expiresAt: string;
}

function basic(creds: ZoomCreds): string {
  return "Basic " + btoa(`${creds.clientId}:${creds.clientSecret}`);
}

/** Network failure or timeout → provider_error, so a hung Zoom never hangs a booking. */
async function call(f: FetchLike, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    return await f(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new ZoomError("provider_error", 0, `Zoom could not be reached: ${(e as Error)?.name || "error"}`);
  }
}

function classify(status: number, body: unknown): ZoomError {
  // deno-lint-ignore no-explicit-any
  const reason = String((body as any)?.reason ?? (body as any)?.error ?? "");
  if (status === 400 && /invalid_grant|invalid token|invalid_request/i.test(reason)) {
    return new ZoomError("invalid_grant", status, "Zoom no longer accepts this connection.");
  }
  if (status === 401) return new ZoomError("unauthorized", status, "Zoom refused the access token.");
  if (status === 404) return new ZoomError("not_found", status, "Zoom has no such meeting.");
  if (status === 429) return new ZoomError("rate_limited", status, "Zoom asked us to slow down.");
  if (status >= 500) return new ZoomError("provider_error", status, `Zoom answered ${status}.`);
  return new ZoomError("refused", status, `Zoom refused the request (${status}).`);
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function tokenRequest(
  creds: ZoomCreds,
  params: Record<string, string>,
  f: FetchLike,
  now: number,
): Promise<ZoomTokens> {
  const res = await call(f, ZOOM_TOKEN_URL, {
    method: "POST",
    headers: { Authorization: basic(creds), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  }, 10_000);
  const body = await readJson(res);
  if (!res.ok) throw classify(res.status, body);
  // deno-lint-ignore no-explicit-any
  const b = body as any;
  if (!b?.access_token || !b?.refresh_token) {
    throw new ZoomError("provider_error", res.status, "Zoom's token answer had no tokens in it.");
  }
  const ttl = Number(b.expires_in) || 3600;
  return {
    accessToken: String(b.access_token),
    refreshToken: String(b.refresh_token),
    expiresAt: new Date(now + ttl * 1000).toISOString(),
  };
}

export function zoomExchangeCode(
  creds: ZoomCreds,
  code: string,
  redirectUri: string,
  f: FetchLike = fetch,
  now = Date.now(),
): Promise<ZoomTokens> {
  return tokenRequest(creds, { grant_type: "authorization_code", code, redirect_uri: redirectUri }, f, now);
}

export function zoomRefresh(
  creds: ZoomCreds,
  refreshToken: string,
  f: FetchLike = fetch,
  now = Date.now(),
): Promise<ZoomTokens> {
  return tokenRequest(creds, { grant_type: "refresh_token", refresh_token: refreshToken }, f, now);
}

/** Best effort: telling Zoom we are done. A failure here never blocks a disconnect. */
export async function zoomRevoke(creds: ZoomCreds, token: string, f: FetchLike = fetch): Promise<boolean> {
  try {
    const res = await call(f, `${ZOOM_REVOKE_URL}?token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { Authorization: basic(creds) },
    }, 8_000);
    return res.ok;
  } catch {
    return false;
  }
}

export interface ZoomUser {
  id: string;
  email: string | null;
  name: string | null;
}

export async function zoomMe(accessToken: string, f: FetchLike = fetch): Promise<ZoomUser> {
  const res = await call(f, `${ZOOM_API}/users/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  }, 8_000);
  const body = await readJson(res);
  if (!res.ok) throw classify(res.status, body);
  // deno-lint-ignore no-explicit-any
  const b = body as any;
  const name = [b?.first_name, b?.last_name].filter(Boolean).join(" ").trim();
  return {
    id: String(b?.id ?? ""),
    email: b?.email ? String(b.email).slice(0, 254) : null,
    name: name ? name.slice(0, 120) : null,
  };
}

export interface ZoomMeetingInput {
  /** What attendees see as the meeting's name. Ours, not the customer's details. */
  topic: string;
  startsAt: string;
  durationMinutes: number;
  timeZone: string;
}

export interface ZoomMeeting {
  id: string;
  joinUrl: string;
  password: string | null;
}

/** Zoom wants yyyy-MM-ddTHH:mm:ssZ, no milliseconds. */
export function zoomTime(iso: string): string {
  return new Date(iso).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function meetingBody(m: ZoomMeetingInput) {
  return {
    topic: m.topic.slice(0, 200),
    type: 2, // scheduled
    start_time: zoomTime(m.startsAt),
    duration: Math.max(1, Math.round(m.durationMinutes)),
    timezone: m.timeZone,
  };
}

export async function zoomCreateMeeting(
  accessToken: string,
  m: ZoomMeetingInput,
  f: FetchLike = fetch,
): Promise<ZoomMeeting> {
  const res = await call(f, `${ZOOM_API}/users/me/meetings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      ...meetingBody(m),
      // A waiting room so the customer is let in by the host rather than finding an empty
      // room, or somebody else's call, if they arrive early.
      settings: { waiting_room: true, join_before_host: false },
    }),
  }, 10_000);
  const body = await readJson(res);
  if (!res.ok) throw classify(res.status, body);
  // deno-lint-ignore no-explicit-any
  const b = body as any;
  const joinUrl = String(b?.join_url ?? "");
  // The link lands in a customer's email and in a calendar invite: https or nothing. The
  // column refuses anything else too (328).
  if (!b?.id || !joinUrl.toLowerCase().startsWith("https://") || joinUrl.length > 500) {
    throw new ZoomError("provider_error", res.status, "Zoom's answer had no usable join link.");
  }
  return { id: String(b.id), joinUrl, password: b?.password ? String(b.password).slice(0, 40) : null };
}

export async function zoomUpdateMeeting(
  accessToken: string,
  meetingId: string,
  m: ZoomMeetingInput,
  f: FetchLike = fetch,
): Promise<void> {
  const res = await call(f, `${ZOOM_API}/meetings/${encodeURIComponent(meetingId)}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(meetingBody(m)),
  }, 10_000);
  if (!res.ok) throw classify(res.status, await readJson(res));
}

/** Already gone at Zoom counts as deleted. */
export async function zoomDeleteMeeting(accessToken: string, meetingId: string, f: FetchLike = fetch): Promise<void> {
  const res = await call(f, `${ZOOM_API}/meetings/${encodeURIComponent(meetingId)}?schedule_for_reminder=false`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  }, 10_000);
  if (res.ok || res.status === 404) return;
  throw classify(res.status, await readJson(res));
}

// ── Webhook signatures (app deauthorisation) ─────────────────────────────────────────────

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Zoom signs `v0:{timestamp}:{raw body}` with the app's secret token, hex, prefixed `v0=`.
 *  A timestamp more than five minutes off is refused, so a captured delivery cannot be replayed. */
export async function zoomVerifyWebhook(
  secret: string,
  timestamp: string | null,
  signature: string | null,
  rawBody: string,
  nowMs = Date.now(),
): Promise<boolean> {
  if (!secret || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const tsMs = ts > 1e12 ? ts : ts * 1000;
  if (Math.abs(nowMs - tsMs) > 5 * 60_000) return false;
  const expected = "v0=" + (await hmacHex(secret, `v0:${timestamp}:${rawBody}`));
  return sameString(expected, signature);
}

/** The answer to Zoom's endpoint.url_validation challenge. */
export async function zoomUrlValidation(secret: string, plainToken: string) {
  return { plainToken, encryptedToken: await hmacHex(secret, plainToken) };
}
