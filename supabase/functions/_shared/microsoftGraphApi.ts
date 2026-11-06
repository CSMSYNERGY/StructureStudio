// microsoftGraphApi.ts — Outlook / Microsoft 365 calendars and Teams links for Meetings (341).
//
// Every call Microsoft Graph needs and nothing about our database. Offline-testable.
//
// One Entra app registration ("Accounts in any organizational directory and personal Microsoft
// accounts") serves every builder; each host signs in with their own Microsoft account.
// Delegated scopes: offline_access (a refresh token), User.Read ("Connected as …") and
// Calendars.ReadWrite (busy times, and putting bookings on their calendar).
// ⚠️ A Teams link needs a WORK OR SCHOOL Microsoft 365 account. A personal Outlook.com account
// still syncs its calendar; the event simply comes back with no Teams link.
// Secrets, added by Carolyn and never read or printed by an agent: MICROSOFT_CLIENT_ID,
// MICROSOFT_CLIENT_SECRET (optional MICROSOFT_TENANT, default "common").
//
// Microsoft DOES rotate the refresh token, like Zoom: store the new one before anything else.

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

const WHO = "Microsoft";
const GRAPH = "https://graph.microsoft.com/v1.0";
export const MS_SCOPES = ["offline_access", "User.Read", "Calendars.ReadWrite"];

export interface MsCreds { clientId: string; clientSecret: string; tenant: string }

export function msCredsFromEnv(get: (k: string) => string | undefined): MsCreds | null {
  const clientId = (get("MICROSOFT_CLIENT_ID") || "").trim();
  const clientSecret = (get("MICROSOFT_CLIENT_SECRET") || "").trim();
  const tenant = ((get("MICROSOFT_TENANT") || "").trim() || "common").replace(/[^A-Za-z0-9.-]/g, "");
  return clientId && clientSecret ? { clientId, clientSecret, tenant } : null;
}

const authBase = (c: MsCreds) => `https://login.microsoftonline.com/${c.tenant}/oauth2/v2.0`;

export function msAuthorizeUrl(creds: MsCreds, redirectUri: string, state: string): string {
  const u = new URL(`${authBase(creds)}/authorize`);
  u.searchParams.set("client_id", creds.clientId);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_mode", "query");
  u.searchParams.set("scope", MS_SCOPES.join(" "));
  u.searchParams.set("prompt", "select_account");
  u.searchParams.set("state", state);
  return u.toString();
}

async function tokenRequest(creds: MsCreds, params: Record<string, string>, f: FetchLike, now: number): Promise<OAuthTokens> {
  const res = await providerCall(f, `${authBase(creds)}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: creds.clientId, client_secret: creds.clientSecret, scope: MS_SCOPES.join(" "), ...params,
    }).toString(),
  }, 10_000, WHO);
  const body = await readJson(res);
  if (!res.ok) throw classify(res.status, body, WHO);
  // deno-lint-ignore no-explicit-any
  const b = body as any;
  if (!b?.access_token) throw new ProviderError("provider_error", res.status, "Microsoft's token answer had no token in it.");
  return {
    accessToken: String(b.access_token),
    refreshToken: b.refresh_token ? String(b.refresh_token) : null,
    expiresAt: new Date(now + (Number(b.expires_in) || 3600) * 1000).toISOString(),
  };
}

export function msExchangeCode(creds: MsCreds, code: string, redirectUri: string, f: FetchLike = fetch, now = Date.now()) {
  return tokenRequest(creds, { grant_type: "authorization_code", code, redirect_uri: redirectUri }, f, now);
}

export function msRefresh(creds: MsCreds, refreshToken: string, f: FetchLike = fetch, now = Date.now()) {
  return tokenRequest(creds, { grant_type: "refresh_token", refresh_token: refreshToken }, f, now);
}

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
// Every time Graph hands back comes back in UTC with this header, so "…T15:30:00.0000000"
// can be read as UTC without guessing which zone the person's mailbox is set to.
const UTC_PREF = { Prefer: 'outlook.timezone="UTC"' };

async function getJson(f: FetchLike, url: string, token: string, timeoutMs = 10_000): Promise<unknown> {
  const res = await providerCall(f, url, { headers: { ...bearer(token), ...UTC_PREF } }, timeoutMs, WHO);
  const body = await readJson(res);
  if (!res.ok) throw classify(res.status, body, WHO);
  return body;
}

export async function msMe(token: string, f: FetchLike = fetch) {
  // deno-lint-ignore no-explicit-any
  const b = (await getJson(f, `${GRAPH}/me?$select=id,mail,userPrincipalName,displayName`, token, 8_000)) as any;
  const email = b?.mail || b?.userPrincipalName || null;
  return {
    id: String(b?.id ?? ""),
    email: email ? String(email).slice(0, 254) : null,
    name: b?.displayName ? String(b.displayName).slice(0, 120) : null,
  };
}

export async function msListCalendars(token: string, f: FetchLike = fetch): Promise<CalendarSummary[]> {
  // deno-lint-ignore no-explicit-any
  const b = (await getJson(f, `${GRAPH}/me/calendars?$select=id,name,isDefaultCalendar,canEdit&$top=100`, token)) as any;
  // deno-lint-ignore no-explicit-any
  return ((b?.value ?? []) as any[]).slice(0, 100).map((c) => ({
    id: String(c.id),
    name: String(c.name || "Calendar").slice(0, 120),
    primary: !!c.isDefaultCalendar,
    canWrite: c.canEdit !== false,
  }));
}

/** "2026-11-03T15:30:00.0000000" (UTC, per the Prefer header) → an ISO instant. */
function utcInstant(dt: unknown): number {
  const s = typeof dt === "string" ? dt : "";
  if (!s) return NaN;
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s + "Z");
}

/** Graph wants a wall-clock time plus a zone; we always send UTC so nothing is ambiguous. */
const graphUtc = (iso: string) => new Date(iso).toISOString().replace(/Z$/, "");

const calPath = (calendarId: string) =>
  calendarId === "primary" ? `${GRAPH}/me/calendar` : `${GRAPH}/me/calendars/${encodeURIComponent(calendarId)}`;

/**
 * Busy blocks across the given calendars from calendarView: events marked free, and cancelled
 * ones, do not block. Keeps the event id as the key, so the caller can drop our own bookings.
 * Follows @odata.nextLink a few pages at most — a 60-day window does not need more.
 */
export async function msBusy(
  token: string, calendarIds: string[], fromIso: string, toIso: string, f: FetchLike = fetch, timeoutMs = 10_000,
): Promise<BusyBlock[]> {
  const out: BusyBlock[] = [];
  for (const calId of calendarIds.slice(0, 20)) {
    let url: string | null = `${calPath(calId)}/calendarView?startDateTime=${encodeURIComponent(fromIso)}` +
      `&endDateTime=${encodeURIComponent(toIso)}&$select=id,start,end,showAs,isCancelled&$top=250`;
    for (let page = 0; url && page < 5; page++) {
      // deno-lint-ignore no-explicit-any
      const b = (await getJson(f, url, token, timeoutMs)) as any;
      // deno-lint-ignore no-explicit-any
      for (const e of (b?.value ?? []) as any[]) {
        if (e?.isCancelled || e?.showAs === "free") continue;
        const s = utcInstant(e?.start?.dateTime), en = utcInstant(e?.end?.dateTime);
        if (!Number.isFinite(s) || !Number.isFinite(en) || en <= s) continue;
        out.push({ startsAt: new Date(s).toISOString(), endsAt: new Date(en).toISOString(), key: `m:${e.id}`.slice(0, 300) });
      }
      url = typeof b?.["@odata.nextLink"] === "string" && b["@odata.nextLink"].startsWith(GRAPH) ? b["@odata.nextLink"] : null;
    }
  }
  return out;
}

function eventBody(ev: Pick<CalendarEventInput, "title" | "description" | "location" | "startsAt" | "endsAt">) {
  return {
    subject: ev.title.slice(0, 250),
    body: { contentType: "text", content: ev.description.slice(0, 4000) },
    start: { dateTime: graphUtc(ev.startsAt), timeZone: "UTC" },
    end: { dateTime: graphUtc(ev.endsAt), timeZone: "UTC" },
    location: ev.location ? { displayName: ev.location.slice(0, 500) } : undefined,
  };
}

/** Microsoft emails every attendee the invite itself, from the host's own mailbox. */
export async function msCreateEvent(token: string, calendarId: string, ev: CalendarEventInput, f: FetchLike = fetch): Promise<CreatedEvent> {
  const body: Record<string, unknown> = {
    ...eventBody(ev),
    attendees: ev.attendee ? [{ emailAddress: { address: ev.attendee.email, name: ev.attendee.name }, type: "required" }] : [],
    allowNewTimeProposals: false,
  };
  if (ev.withVideo) {
    body.isOnlineMeeting = true;
    body.onlineMeetingProvider = "teamsForBusiness";
  }
  const res = await providerCall(f, `${calPath(calendarId)}/events`, {
    method: "POST", headers: { ...bearer(token), ...UTC_PREF, "Content-Type": "application/json" }, body: JSON.stringify(body),
  }, 12_000, WHO);
  const out = await readJson(res);
  if (!res.ok) throw classify(res.status, out, WHO);
  // deno-lint-ignore no-explicit-any
  const o = out as any;
  if (!o?.id) throw new ProviderError("provider_error", res.status, "Microsoft's answer had no event id.");
  let joinUrl = ev.withVideo ? safeJoinUrl(o?.onlineMeeting?.joinUrl) : null;
  if (ev.withVideo && !joinUrl) {
    // deno-lint-ignore no-explicit-any
    const again = (await getJson(f, `${GRAPH}/me/events/${encodeURIComponent(o.id)}?$select=onlineMeeting`, token).catch(() => null)) as any;
    joinUrl = safeJoinUrl(again?.onlineMeeting?.joinUrl);
  }
  return { id: String(o.id), joinUrl };
}

/** Graph tells the attendees about an organizer's change itself. */
export async function msPatchEvent(
  token: string, eventId: string, ev: Pick<CalendarEventInput, "title" | "description" | "location" | "startsAt" | "endsAt">, f: FetchLike = fetch,
): Promise<void> {
  const res = await providerCall(f, `${GRAPH}/me/events/${encodeURIComponent(eventId)}`, {
    method: "PATCH", headers: { ...bearer(token), "Content-Type": "application/json" }, body: JSON.stringify(eventBody(ev)),
  }, 12_000, WHO);
  if (!res.ok) throw classify(res.status, await readJson(res), WHO);
}

/**
 * Cancel (which sends the attendees a cancellation) and fall back to a plain delete when there
 * is nobody to tell — Graph refuses `cancel` on an event with no attendees. Gone already = done.
 */
export async function msCancelEvent(token: string, eventId: string, hasAttendee: boolean, f: FetchLike = fetch): Promise<void> {
  if (hasAttendee) {
    const res = await providerCall(f, `${GRAPH}/me/events/${encodeURIComponent(eventId)}/cancel`, {
      method: "POST", headers: { ...bearer(token), "Content-Type": "application/json" },
      body: JSON.stringify({ comment: "This meeting has been cancelled." }),
    }, 12_000, WHO);
    if (res.ok || res.status === 404) return;
    if (res.status !== 400) throw classify(res.status, await readJson(res), WHO);
  }
  const del = await providerCall(f, `${GRAPH}/me/events/${encodeURIComponent(eventId)}`, { method: "DELETE", headers: bearer(token) }, 12_000, WHO);
  if (del.ok || del.status === 404) return;
  throw classify(del.status, await readJson(del), WHO);
}
