// calendarProviders.test.ts — the Google Calendar and Microsoft Graph calls (migration 341).
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  googleAuthorizeUrl, googleCreateEvent, googleDeleteEvent, googleFreeBusy, googleListCalendars, googleRefresh,
} from "./googleCalendarApi.ts";
import { msAuthorizeUrl, msBusy, msCancelEvent, msCreateEvent, msCredsFromEnv, msRefresh } from "./microsoftGraphApi.ts";
import { ProviderError, type CalendarEventInput } from "./providerHttp.ts";

const G = { clientId: "gid", clientSecret: "gsecret" };
const M = { clientId: "mid", clientSecret: "msecret", tenant: "common" };
const EV: CalendarEventInput = {
  title: "Site visit: Jane & Carolyn", description: "Notes", location: null,
  startsAt: "2026-11-03T15:30:00.000Z", endsAt: "2026-11-03T16:00:00.000Z", timeZone: "America/Chicago",
  attendee: { email: "jane@example.com", name: "Jane" }, withVideo: false, requestId: "ss-m1",
};
type Call = { url: string; init?: RequestInit };
function stub(answer: (url: string, init?: RequestInit) => Response) {
  const calls: Call[] = [];
  const f = (url: string, init?: RequestInit) => { calls.push({ url, init }); return Promise.resolve(answer(url, init)); };
  return { f, calls };
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

Deno.test("Google consent asks for offline access, the four scopes, and never carries the secret", () => {
  const u = new URL(googleAuthorizeUrl(G, "https://x/cb", "S".repeat(40)));
  assertEquals(u.searchParams.get("access_type"), "offline");
  assertEquals(u.searchParams.get("prompt"), "consent");
  const scope = u.searchParams.get("scope")!;
  assert(scope.includes("calendar.events") && scope.includes("calendar.freebusy") && scope.includes("calendarlist.readonly"));
  assert(!u.toString().includes("gsecret"));
});

Deno.test("Microsoft consent asks for offline_access and Calendars.ReadWrite on the common tenant", () => {
  const u = new URL(msAuthorizeUrl(M, "https://x/cb", "S".repeat(40)));
  assertEquals(u.origin + u.pathname, "https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
  assert(u.searchParams.get("scope")!.includes("Calendars.ReadWrite"));
  assert(u.searchParams.get("scope")!.includes("offline_access"));
  assertEquals(msCredsFromEnv((k) => ({ MICROSOFT_CLIENT_ID: "a", MICROSOFT_CLIENT_SECRET: "b", MICROSOFT_TENANT: "x/../y" } as Record<string, string>)[k])!.tenant, "x..y");
});

Deno.test("a Google refresh with no new refresh token says so (keep the old one)", async () => {
  const s = stub(() => json({ access_token: "A2", expires_in: 3600 }));
  const t = await googleRefresh(G, "R1", s.f, Date.parse("2026-11-01T00:00:00Z"));
  assertEquals(t, { accessToken: "A2", refreshToken: null, expiresAt: "2026-11-01T01:00:00.000Z" });
  assert(String(s.calls[0].init!.body).includes("client_secret=gsecret"));
});

Deno.test("a Microsoft refresh hands back the ROTATED refresh token", async () => {
  const s = stub(() => json({ access_token: "A2", refresh_token: "R2", expires_in: 3600 }));
  assertEquals((await msRefresh(M, "R1", s.f)).refreshToken, "R2");
});

Deno.test("a dead refresh token reads as invalid_grant on both providers", async () => {
  const s = stub(() => json({ error: "invalid_grant" }, 400));
  assertEquals((await assertRejects(() => googleRefresh(G, "R", s.f), ProviderError) as ProviderError).code, "invalid_grant");
  assertEquals((await assertRejects(() => msRefresh(M, "R", s.f), ProviderError) as ProviderError).code, "invalid_grant");
});

Deno.test("Google calendars come back with which ones can hold a booking", async () => {
  const s = stub(() => json({ items: [
    { id: "me@x.com", summary: "Me", primary: true, accessRole: "owner" },
    { id: "fam", summary: "Family", accessRole: "reader" },
  ] }));
  const cals = await googleListCalendars("T", s.f);
  assertEquals(cals, [
    { id: "me@x.com", name: "Me", primary: true, canWrite: true },
    { id: "fam", name: "Family", primary: false, canWrite: false },
  ]);
});

Deno.test("Google freeBusy: times only, across every calendar asked for", async () => {
  const s = stub(() => json({ calendars: {
    primary: { busy: [{ start: "2026-11-03T15:00:00Z", end: "2026-11-03T16:00:00Z" }] },
    fam: { busy: [{ start: "2026-11-04T18:00:00Z", end: "2026-11-04T19:00:00Z" }, { start: "bad", end: "x" }] },
  } }));
  const b = await googleFreeBusy("T", ["primary", "fam"], "2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z", s.f);
  assertEquals(b.length, 2);
  assertEquals(b[0].startsAt, "2026-11-03T15:00:00.000Z");
  assertEquals(JSON.parse(String(s.calls[0].init!.body)).items, [{ id: "primary" }, { id: "fam" }]);
});

Deno.test("a Google event invites the customer (sendUpdates=all) and returns the Meet link", async () => {
  const s = stub(() => json({ id: "ev1", hangoutLink: "https://meet.google.com/abc-defg-hij" }));
  const made = await googleCreateEvent("T", "primary", { ...EV, withVideo: true }, s.f);
  assertEquals(made, { id: "ev1", joinUrl: "https://meet.google.com/abc-defg-hij" });
  assert(s.calls[0].url.includes("sendUpdates=all") && s.calls[0].url.includes("conferenceDataVersion=1"));
  const body = JSON.parse(String(s.calls[0].init!.body));
  assertEquals(body.attendees, [{ email: "jane@example.com", displayName: "Jane" }]);
  assertEquals(body.conferenceData.createRequest.conferenceSolutionKey.type, "hangoutsMeet");
  assertEquals(body.start, { dateTime: EV.startsAt, timeZone: "America/Chicago" });
});

Deno.test("no customer email: nobody is emailed by Google (sendUpdates=none)", async () => {
  const s = stub(() => json({ id: "ev1" }));
  await googleCreateEvent("T", "primary", { ...EV, attendee: null }, s.f);
  assert(s.calls[0].url.includes("sendUpdates=none"));
});

Deno.test("a Meet link still being made is read back once", async () => {
  let n = 0;
  const s = stub(() => (n++ === 0 ? json({ id: "ev1" }) : json({ id: "ev1", hangoutLink: "https://meet.google.com/x" })));
  assertEquals((await googleCreateEvent("T", "primary", { ...EV, withVideo: true }, s.f)).joinUrl, "https://meet.google.com/x");
});

Deno.test("deleting a Google event that is already gone counts as done", async () => {
  await googleDeleteEvent("T", "primary", "ev1", true, () => Promise.resolve(new Response(null, { status: 410 })));
});

Deno.test("Microsoft busy: free and cancelled events do not block; times are read as UTC", async () => {
  const s = stub(() => json({ value: [
    { id: "a", start: { dateTime: "2026-11-03T15:00:00.0000000" }, end: { dateTime: "2026-11-03T16:00:00.0000000" }, showAs: "busy" },
    { id: "b", start: { dateTime: "2026-11-03T17:00:00.0000000" }, end: { dateTime: "2026-11-03T18:00:00.0000000" }, showAs: "free" },
    { id: "c", start: { dateTime: "2026-11-03T19:00:00.0000000" }, end: { dateTime: "2026-11-03T20:00:00.0000000" }, isCancelled: true },
  ] }));
  const b = await msBusy("T", ["primary"], "2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z", s.f);
  assertEquals(b, [{ startsAt: "2026-11-03T15:00:00.000Z", endsAt: "2026-11-03T16:00:00.000Z", key: "m:a" }]);
  assert(s.calls[0].url.startsWith("https://graph.microsoft.com/v1.0/me/calendar/calendarView"));
  assertEquals((s.calls[0].init!.headers as Record<string, string>).Prefer, 'outlook.timezone="UTC"');
});

Deno.test("a Microsoft event asks for Teams and returns its join link; times go as UTC", async () => {
  const s = stub(() => json({ id: "ev9", onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/x" } }));
  const made = await msCreateEvent("T", "primary", { ...EV, withVideo: true }, s.f);
  assertEquals(made.joinUrl, "https://teams.microsoft.com/l/meetup-join/x");
  const body = JSON.parse(String(s.calls[0].init!.body));
  assertEquals(body.onlineMeetingProvider, "teamsForBusiness");
  assertEquals(body.start, { dateTime: "2026-11-03T15:30:00.000", timeZone: "UTC" });
  assertEquals(body.attendees[0].emailAddress.address, "jane@example.com");
});

Deno.test("a personal Outlook account gives no Teams link: joinUrl comes back null, not an error", async () => {
  const s = stub(() => json({ id: "ev9", onlineMeeting: null }));
  assertEquals((await msCreateEvent("T", "primary", { ...EV, withVideo: true }, s.f)).joinUrl, null);
});

Deno.test("cancelling a Microsoft event with a guest sends the cancellation; with none it deletes", async () => {
  const a = stub(() => new Response(null, { status: 202 }));
  await msCancelEvent("T", "ev9", true, a.f);
  assert(a.calls[0].url.endsWith("/me/events/ev9/cancel"));
  const b = stub(() => new Response(null, { status: 204 }));
  await msCancelEvent("T", "ev9", false, b.f);
  assertEquals(b.calls[0].init!.method, "DELETE");
});

Deno.test("a link that is not https never comes back out", async () => {
  const s = stub(() => json({ id: "ev1", hangoutLink: "javascript:alert(1)" }));
  let n = 0;
  const s2 = stub(() => (n++ === 0 ? json({ id: "ev1", hangoutLink: "javascript:alert(1)" }) : json({ hangoutLink: "http://x" })));
  assertEquals((await googleCreateEvent("T", "primary", { ...EV, withVideo: true }, s2.f)).joinUrl, null);
  void s;
});
