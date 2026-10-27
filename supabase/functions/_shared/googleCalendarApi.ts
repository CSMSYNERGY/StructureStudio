// googleCalendarApi.ts — Google Calendar and Meet for Meetings (migration 341).
//
// Every call Google needs and nothing about our database: meetingCalendar.ts owns the rows.
// Offline-testable (no jsr: imports, injectable fetch).
//
// One OAuth client (a "Web application" in Google Cloud) serves every builder; each host
// authorises their own Google account. Scopes, all requested at once so nobody reconnects later:
//   openid email          — "Connected as jane@acme.com"
//   calendar.events       — put a booking on their calendar, with a Meet link when asked
//   calendar.calendarlist.readonly — list their calendars so they can tick which block times
//   calendar.freebusy     — read busy times (times only: no titles, no attendees)
// The calendar scopes are SENSITIVE: until Google verifies the app, only test users added in
// Google Cloud can connect, and they see an "unverified app" screen. Secrets, added by Carolyn
// and never read or printed by an agent: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET.
//
// Google does NOT usually rotate the refresh token on refresh (the answer has none), so a null
// refreshToken means "keep the one you have" — the opposite of Zoom.

import {
  type BusyBlock,
  type CalendarEventInput,
  type CalendarSummary,
  type CreatedEvent,
  type FetchLike,
  type OAuthTokens,
  ProviderError,
  classify,
  providerCall,
  readJson,
  safeJoinUrl,
} from "./providerHttp.ts";

const WHO = "Google";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const CAL = "https://www.googleapis.com/calendar/v3";

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.freebusy",
];

export interface GoogleCreds { clientId: string; clientSecret: string }

export function googleCredsFromEnv(get: (k: string) => string | undefined): GoogleCreds | null {
  const clientId = (get("GOOGLE_OAUTH_CLIENT_ID") || "").trim();
  const clientSecret = (get("GOOGLE_OAUTH_CLIENT_SECRET") || "").trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export function googleAuthorizeUrl(creds: GoogleCreds, redirectUri: string, state: string): string {
  const u = new URL(AUTH_URL);
  u.searchParams.set("client_id", creds.clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  // offline + consent: without both, Google returns no refresh token on a second connect, and
  // the connection dies the first time the hour-long access token expires.
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("include_granted_scopes", "true");
  u.searchParams.set("state", state);
  return u.toString();
}

async function tokenRequest(creds: GoogleCreds, params: Record<string, string>, f: FetchLike, now: number): Promise<OAuthTokens> {
  const res = await providerCall(f, TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: creds.clientId, client_secret: creds.clientSecret, ...params }).toString(),
  }, 10_000, WHO);
  const body = await readJson(res);
  if (!res.ok) throw classify(res.status, body, WHO);
  // deno-lint-ignore no-explicit-any
  const b = body as any;
  if (!b?.access_token) throw new ProviderError("provider_error", res.status, "Google's token answer had no token in it.");
  return {
    accessToken: String(b.access_token),
    refreshToken: b.refresh_token ? String(b.refresh_token) : null,
    expiresAt: new Date(now + (Number(b.expires_in) || 3600) * 1000).toISOString(),
  };
}

export function googleExchangeCode(creds: GoogleCreds, code: string, redirectUri: string, f: FetchLike = fetch, now = Date.now()) {
  return tokenRequest(creds, { grant_type: "authorization_code", code, redirect_uri: redirectUri }, f, now);
}

export function googleRefresh(creds: GoogleCreds, refreshToken: string, f: FetchLike = fetch, now = Date.now()) {
  return tokenRequest(creds, { grant_type: "refresh_token", refresh_token: refreshToken }, f, now);
}

/** Best effort: a failure never blocks a disconnect (the row is deleted either way). */
export async function googleRevoke(token: string, f: FetchLike = fetch): Promise<boolean> {
  try {
    const res = await providerCall(f, `${REVOKE_URL}?token=${encodeURIComponent(token)}`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }, 8_000, WHO);
    return res.ok;
  } catch {
    return false;
  }
}

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

async function getJson(f: FetchLike, url: string, token: string, timeoutMs = 10_000): Promise<unknown> {
  const res = await providerCall(f, url, { headers: bearer(token) }, timeoutMs, WHO);
  const body = await readJson(res);
  if (!res.ok) throw classify(res.status, body, WHO);
  return body;
}

export async function googleMe(token: string, f: FetchLike = fetch) {
  // deno-lint-ignore no-explicit-any
  const b = (await getJson(f, USERINFO_URL, token, 8_000)) as any;
  return {
    id: String(b?.sub ?? ""),
    email: b?.email ? String(b.email).slice(0, 254) : null,
    name: b?.name ? String(b.name).slice(0, 120) : null,
  };
}

export async function googleListCalendars(token: string, f: FetchLike = fetch): Promise<CalendarSummary[]> {
  // deno-lint-ignore no-explicit-any
  const b = (await getJson(f, `${CAL}/users/me/calendarList?minAccessRole=freeBusyReader&maxResults=100`, token)) as any;
  // deno-lint-ignore no-explicit-any
  return ((b?.items ?? []) as any[]).slice(0, 100).map((c) => ({
    id: String(c.id),
    name: String(c.summaryOverride || c.summary || c.id).slice(0, 120),
    primary: !!c.primary,
    canWrite: c.accessRole === "owner" || c.accessRole === "writer",
  }));
}

/**
 * Busy blocks across the given calendars ("primary" included by the caller). freeBusy answers
 * with times only, which is exactly what we keep. It has no event ids, so the key is built from
 * the calendar and the times; the caller drops blocks that ARE one of our own bookings.
 */
export async function googleFreeBusy(
  token: string, calendarIds: string[], fromIso: string, toIso: string, f: FetchLike = fetch, timeoutMs = 10_000,
): Promise<BusyBlock[]> {
  const res = await providerCall(f, `${CAL}/freeBusy`, {
    method: "POST",
    headers: { ...bearer(token), "Content-Type": "application/json" },
    body: JSON.stringify({ timeMin: fromIso, timeMax: toIso, items: calendarIds.slice(0, 50).map((id) => ({ id })) }),
  }, timeoutMs, WHO);
  const body = await readJson(res);
  if (!res.ok) throw classify(res.status, body, WHO);
  const out: BusyBlock[] = [];
  // deno-lint-ignore no-explicit-any
  const cals = ((body as any)?.calendars ?? {}) as Record<string, any>;
  for (const [calId, cal] of Object.entries(cals)) {
    // deno-lint-ignore no-explicit-any
    for (const b of (cal?.busy ?? []) as any[]) {
      const s = Date.parse(b?.start), e = Date.parse(b?.end);
      if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue;
      out.push({ startsAt: new Date(s).toISOString(), endsAt: new Date(e).toISOString(), key: `g:${calId}:${s}:${e}`.slice(0, 300) });
    }
  }
  return out;
}

function eventBody(ev: CalendarEventInput) {
  return {
    summary: ev.title.slice(0, 250),
    description: ev.description.slice(0, 4000),
    location: ev.location ? ev.location.slice(0, 500) : undefined,
    start: { dateTime: ev.startsAt, timeZone: ev.timeZone },
    end: { dateTime: ev.endsAt, timeZone: ev.timeZone },
  };
}

/** sendUpdates=all: Google emails the guest the invite (and later the change or cancellation). */
export async function googleCreateEvent(
  token: string, calendarId: string, ev: CalendarEventInput, f: FetchLike = fetch,
): Promise<CreatedEvent> {
  const body: Record<string, unknown> = {
    ...eventBody(ev),
    attendees: ev.attendee ? [{ email: ev.attendee.email, displayName: ev.attendee.name }] : [],
    guestsCanModify: false,
    guestsCanInviteOthers: false,
  };
  if (ev.withVideo) {
    body.conferenceData = { createRequest: { requestId: ev.requestId, conferenceSolutionKey: { type: "hangoutsMeet" } } };
  }
  const url = `${CAL}/calendars/${encodeURIComponent(calendarId)}/events?sendUpdates=${ev.attendee ? "all" : "none"}&conferenceDataVersion=1`;
  const res = await providerCall(f, url, {
    method: "POST", headers: { ...bearer(token), "Content-Type": "application/json" }, body: JSON.stringify(body),
  }, 12_000, WHO);
  const out = await readJson(res);
  if (!res.ok) throw classify(res.status, out, WHO);
  // deno-lint-ignore no-explicit-any
  const o = out as any;
  if (!o?.id) throw new ProviderError("provider_error", res.status, "Google's answer had no event id.");
  let joinUrl = ev.withVideo ? safeJoinUrl(o.hangoutLink) : null;
  if (ev.withVideo && !joinUrl) {
    // Meet creation can be asynchronous ("pending"): read the event back once.
    // deno-lint-ignore no-explicit-any
    const again = (await getJson(f, `${CAL}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(o.id)}`, token).catch(() => null)) as any;
    joinUrl = safeJoinUrl(again?.hangoutLink);
  }
  return { id: String(o.id), joinUrl };
}

export async function googlePatchEvent(
  token: string, calendarId: string, eventId: string, ev: Pick<CalendarEventInput, "startsAt" | "endsAt" | "timeZone" | "location" | "description" | "title">,
  notify: boolean, f: FetchLike = fetch,
): Promise<void> {
  const url = `${CAL}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=${notify ? "all" : "none"}`;
  const res = await providerCall(f, url, {
    method: "PATCH", headers: { ...bearer(token), "Content-Type": "application/json" },
    body: JSON.stringify(eventBody({ ...ev, attendee: null, withVideo: false, requestId: "" })),
  }, 12_000, WHO);
  if (!res.ok) throw classify(res.status, await readJson(res), WHO);
}

/** Already gone at Google counts as deleted. */
export async function googleDeleteEvent(token: string, calendarId: string, eventId: string, notify: boolean, f: FetchLike = fetch): Promise<void> {
  const url = `${CAL}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=${notify ? "all" : "none"}`;
  const res = await providerCall(f, url, { method: "DELETE", headers: bearer(token) }, 12_000, WHO);
  if (res.ok || res.status === 404 || res.status === 410) return;
  throw classify(res.status, await readJson(res), WHO);
}
