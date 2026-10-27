// meetingCalendar.test.ts — bookings on the host's calendar, Meet / Teams links and busy times
// (migration 341), against an in-memory stand-in for the service-role client.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  dropCalendarEvent, ensureCalendarEvent, liveBusyCheck, moveCalendarEvent, onBooked, syncConnectionBusy,
} from "./meetingCalendar.ts";
import type { VideoEnv } from "./meetingVideo.ts";

type Row = Record<string, unknown>;
function splitTop(s: string): string[] {
  const out: string[] = []; let d = 0, cur = "";
  for (const ch of s) { if (ch === "(") d++; if (ch === ")") d--; if (ch === "," && d === 0) { out.push(cur); cur = ""; } else cur += ch; }
  if (cur) out.push(cur); return out;
}
function orFilter(expr: string) {
  const parts = splitTop(expr).map((p) => {
    const [col, op, ...rest] = p.split("."); const val = rest.join(".");
    return (r: Row) => op === "is" ? r[col] == null
      : op === "in" ? val.replace(/[()]/g, "").split(",").includes(String(r[col]))
      : op === "lt" ? r[col] != null && String(r[col]) < val : String(r[col]) === val;
  });
  return (r: Row) => parts.some((f) => f(r));
}
function fakeAdmin(tables: Record<string, Row[]>) {
  return {
    tables,
    from(name: string) {
      const rows = tables[name] ?? (tables[name] = []);
      const filters: ((r: Row) => boolean)[] = [];
      let op: "select" | "update" | "delete" | "upsert" = "select";
      let patch: Row = {}; let up: Row[] = []; let conflict: string[] = []; let lim = Infinity;
      const b = {
        select() { return b; },
        update(p: Row) { op = "update"; patch = p; return b; },
        delete() { op = "delete"; return b; },
        upsert(r: Row[], o: { onConflict: string }) { op = "upsert"; up = r; conflict = o.onConflict.split(","); return b; },
        eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return b; },
        is(c: string, v: unknown) { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
        in(c: string, v: unknown[]) { filters.push((r) => v.includes(r[c])); return b; },
        lt(c: string, v: string) { filters.push((r) => r[c] != null && String(r[c]) < v); return b; },
        gt(c: string, v: string) { filters.push((r) => r[c] != null && String(r[c]) > v); return b; },
        or(e: string) { filters.push(orFilter(e)); return b; },
        order() { return b; },
        limit(n: number) { lim = n; return b; },
        run() {
          if (op === "upsert") {
            for (const r of up) {
              const hit = rows.find((x) => conflict.every((k) => x[k] === r[k]));
              if (hit) Object.assign(hit, r); else rows.push({ ...r });
            }
            return up;
          }
          const hit = rows.filter((r) => filters.every((f) => f(r))).slice(0, lim);
          if (op === "update") hit.forEach((r) => Object.assign(r, patch));
          if (op === "delete") hit.forEach((r) => rows.splice(rows.indexOf(r), 1));
          return hit;
        },
        maybeSingle() { const h = b.run(); return Promise.resolve({ data: h[0] ? { ...h[0] } : null, error: null }); },
        then(res: (v: unknown) => unknown) { const h = b.run(); return Promise.resolve({ data: h.map((x) => ({ ...x })), error: null }).then(res); },
      };
      return b;
    },
  };
}

const NOW = Date.parse("2026-11-01T12:00:00Z");
const KEYS: Record<string, string> = {
  GOOGLE_OAUTH_CLIENT_ID: "g", GOOGLE_OAUTH_CLIENT_SECRET: "gs", MICROSOFT_CLIENT_ID: "m", MICROSOFT_CLIENT_SECRET: "ms",
};
const env = (f: VideoEnv["fetch"], keys = KEYS): VideoEnv => ({ get: (k) => keys[k], fetch: f, now: () => NOW });
const conn = (provider: string, extra: Row = {}): Row => ({
  id: `c-${provider}`, client_id: "acme", host_id: "h1", user_id: "u1", provider, status: "connected",
  access_token: "A1", refresh_token: "R1", token_expires: "2026-11-01T13:00:00.000Z",
  busy_calendar_ids: [], write_calendar_id: null, ...extra,
});
function world(o: { type?: Row; conns?: Row[]; meeting?: Row; hostCal?: string | null } = {}) {
  const m: Row = {
    id: "m1", client_id: "acme", host_id: "h1", status: "booked",
    starts_at: "2026-11-03T15:30:00.000Z", ends_at: "2026-11-03T16:00:00.000Z",
    customer_name: "Jane Doe", customer_email: "jane@example.com", customer_notes: null, cancel_token: "tok",
    conference_provider: "none", conference_url: null, conference_note: null, conference_external_id: null, conference_status: null,
    external_event_id: null, external_provider: null, external_calendar_id: null, calendar_invited: false,
    calendar_status: null, calendar_attempted_at: null,
    meeting_types: { name: "Site visit", location_kind: "in_person", location_detail: "Our lot", conference_mode: "room", conference_provider: "none", ...(o.type ?? {}) },
    meeting_hosts: { public_name: "Carolyn", time_zone: "America/Chicago", calendar_provider: o.hostCal ?? null },
    ...(o.meeting ?? {}),
  };
  return fakeAdmin({
    meetings: [m], meeting_connections: o.conns ?? [conn("google")], meeting_busy: [],
    client_settings: [{ client_id: "acme", business_name: "Acme Barns" }], client_configs: [],
  });
}
function provider(routes: Record<string, (init?: RequestInit) => Response>) {
  const calls: { method: string; url: string; init?: RequestInit }[] = [];
  const f = (url: string, init?: RequestInit) => {
    const method = init?.method || "GET";
    calls.push({ method, url, init });
    const k = Object.keys(routes).find((r) => `${method} ${url}`.startsWith(r));
    return Promise.resolve(k ? routes[k](init) : new Response("{}", { status: 599 }));
  };
  return { f, calls };
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s });
const GCREATE = "POST https://www.googleapis.com/calendar/v3/calendars/primary/events";
const MCREATE = "POST https://graph.microsoft.com/v1.0/me/calendar/events";

Deno.test("every booking goes on the host's Google calendar with the customer as a guest", async () => {
  const admin = world();
  const p = provider({ [GCREATE]: () => json({ id: "ev1" }) });
  const out = await ensureCalendarEvent(admin, "m1", env(p.f));
  assertEquals(out, { status: "created", video: "none" });
  const m = admin.tables.meetings[0];
  assertEquals([m.external_event_id, m.external_provider, m.calendar_invited, m.calendar_status], ["ev1", "google", true, "created"]);
  const body = JSON.parse(String(p.calls[0].init!.body));
  assertEquals(body.summary, "Site visit: Jane Doe & Carolyn");
  assertEquals(body.location, "Our lot");
  assert(String(body.description).includes("book?manage=tok"));
});

Deno.test("no calendar connected: skipped, nothing invited, today's .ics path stays", async () => {
  const admin = world({ conns: [] });
  assertEquals(await ensureCalendarEvent(admin, "m1", env(provider({}).f)), { status: "skipped", reason: "not_connected" });
  assertEquals(admin.tables.meetings[0].calendar_invited, false);
  assertEquals(admin.tables.meetings[0].calendar_status, "skipped");
});

Deno.test("secrets not set yet: a connected row is treated as not connected", async () => {
  const admin = world();
  const p = provider({});
  assertEquals((await ensureCalendarEvent(admin, "m1", env(p.f, {}))).status, "skipped");
  assertEquals(p.calls.length, 0);
});

Deno.test("a Meet type gets its link from the Google event", async () => {
  const admin = world({ type: { location_kind: "video", conference_mode: "generate", conference_provider: "google_meet" } });
  const p = provider({ [GCREATE]: () => json({ id: "ev1", hangoutLink: "https://meet.google.com/abc" }) });
  assertEquals(await ensureCalendarEvent(admin, "m1", env(p.f)), { status: "created", video: "made" });
  const m = admin.tables.meetings[0];
  assertEquals([m.conference_provider, m.conference_url, m.conference_status, m.conference_external_id], ["google_meet", "https://meet.google.com/abc", "generated", "ev1"]);
});

Deno.test("a Teams type goes on Microsoft even when bookings normally go to Google", async () => {
  const admin = world({ hostCal: "google", conns: [conn("google"), conn("microsoft")], type: { location_kind: "video", conference_mode: "generate", conference_provider: "teams" } });
  const p = provider({ [MCREATE]: () => json({ id: "ev9", onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/x" } }) });
  assertEquals(await ensureCalendarEvent(admin, "m1", env(p.f)), { status: "created", video: "made" });
  assertEquals(admin.tables.meetings[0].external_provider, "microsoft");
  assertEquals(admin.tables.meetings[0].conference_url, "https://teams.microsoft.com/l/x");
});

Deno.test("a Meet type whose host only has Outlook: event on Outlook, the link falls back", async () => {
  const admin = world({ conns: [conn("microsoft")], type: { location_kind: "video", conference_mode: "generate", conference_provider: "google_meet" } });
  const p = provider({ [MCREATE]: () => json({ id: "ev9" }) });
  assertEquals(await ensureCalendarEvent(admin, "m1", env(p.f)), { status: "created", video: "none" });
  const m = admin.tables.meetings[0];
  assertEquals([m.external_provider, m.conference_status, m.conference_error], ["microsoft", "failed", "not_connected"]);
});

Deno.test("a personal Outlook account: the event is made, the Teams link is not, the booking says so", async () => {
  const admin = world({ conns: [conn("microsoft")], type: { location_kind: "video", conference_mode: "generate", conference_provider: "teams" } });
  const p = provider({ [MCREATE]: () => json({ id: "ev9", onlineMeeting: null }), "GET https://graph.microsoft.com": () => json({ onlineMeeting: null }) });
  assertEquals(await ensureCalendarEvent(admin, "m1", env(p.f)), { status: "created", video: "missing" });
  assertEquals(admin.tables.meetings[0].conference_error, "no_link");
  assertEquals(admin.tables.meetings[0].calendar_invited, true);
});

Deno.test("the host's choice decides where bookings go when both are connected", async () => {
  const admin = world({ hostCal: "microsoft", conns: [conn("google"), conn("microsoft")] });
  const p = provider({ [MCREATE]: () => json({ id: "ev9" }) });
  await ensureCalendarEvent(admin, "m1", env(p.f));
  assertEquals(admin.tables.meetings[0].external_provider, "microsoft");
});

Deno.test("a chosen calendar is written to instead of the primary", async () => {
  const admin = world({ conns: [conn("google", { write_calendar_id: "work@x.com" })] });
  const p = provider({ "POST https://www.googleapis.com/calendar/v3/calendars/work%40x.com/events": () => json({ id: "ev1" }) });
  assertEquals((await ensureCalendarEvent(admin, "m1", env(p.f))).status, "created");
  assertEquals(admin.tables.meetings[0].external_calendar_id, "work@x.com");
});

Deno.test("no customer email: the event is made, nobody is invited, our .ics still goes", async () => {
  const admin = world({ meeting: { customer_email: null } });
  const p = provider({ [GCREATE]: () => json({ id: "ev1" }) });
  await ensureCalendarEvent(admin, "m1", env(p.f));
  assertEquals(admin.tables.meetings[0].calendar_invited, false);
});

Deno.test("Google down: failed, never a thrown booking, and the email keeps its .ics", async () => {
  const admin = world();
  const p = provider({ [GCREATE]: () => json({}, 503) });
  assertEquals(await ensureCalendarEvent(admin, "m1", env(p.f)), { status: "failed", reason: "provider_error" });
  assertEquals(admin.tables.meetings[0].calendar_invited, false);
});

Deno.test("calling it twice does not make two events", async () => {
  const admin = world();
  const p = provider({ [GCREATE]: () => json({ id: "ev1" }) });
  await ensureCalendarEvent(admin, "m1", env(p.f));
  await ensureCalendarEvent(admin, "m1", env(p.f));
  assertEquals(p.calls.filter((c) => c.method === "POST").length, 1);
});

Deno.test("an expired Microsoft token is refreshed and the ROTATED refresh token stored", async () => {
  const admin = world({ conns: [conn("microsoft", { token_expires: "2026-11-01T11:00:00.000Z" })] });
  const p = provider({
    "POST https://login.microsoftonline.com/common/oauth2/v2.0/token": () => json({ access_token: "A2", refresh_token: "R2", expires_in: 3600 }),
    [MCREATE]: () => json({ id: "ev9" }),
  });
  await ensureCalendarEvent(admin, "m1", env(p.f));
  assertEquals(admin.tables.meeting_connections[0].refresh_token, "R2");
});

Deno.test("a Google refresh with no new refresh token keeps the old one", async () => {
  const admin = world({ conns: [conn("google", { token_expires: "2026-11-01T11:00:00.000Z" })] });
  const p = provider({ "POST https://oauth2.googleapis.com/token": () => json({ access_token: "A2", expires_in: 3600 }), [GCREATE]: () => json({ id: "ev1" }) });
  await ensureCalendarEvent(admin, "m1", env(p.f));
  assertEquals(admin.tables.meeting_connections[0].refresh_token, "R1");
  assertEquals(admin.tables.meeting_connections[0].access_token, "A2");
});

Deno.test("a revoked Google connection is marked for reconnecting; the booking stands", async () => {
  const admin = world({ conns: [conn("google", { access_token: null, token_expires: null })] });
  const p = provider({ "POST https://oauth2.googleapis.com/token": () => json({ error: "invalid_grant" }, 400) });
  assertEquals(await ensureCalendarEvent(admin, "m1", env(p.f)), { status: "failed", reason: "needs_reconnect" });
  assertEquals(admin.tables.meeting_connections[0].status, "needs_reauth");
  assertEquals(admin.tables.meetings[0].status, "booked");
});

Deno.test("a reschedule moves the event and tells the guest", async () => {
  const admin = world({ meeting: { external_event_id: "ev1", external_provider: "google", external_calendar_id: "primary", calendar_invited: true, calendar_status: "created" } });
  const p = provider({ "PATCH https://www.googleapis.com/calendar/v3/calendars/primary/events/ev1": () => json({}) });
  assertEquals(await moveCalendarEvent(admin, "m1", env(p.f)), { status: "moved" });
  assert(p.calls[0].url.includes("sendUpdates=all"));
});

Deno.test("an event deleted by hand is put back on the calendar when the booking moves", async () => {
  const admin = world({ meeting: { external_event_id: "ev1", external_provider: "google", external_calendar_id: "primary", calendar_invited: true, calendar_status: "created" } });
  const p = provider({ "PATCH https://www.googleapis.com": () => json({}, 404), [GCREATE]: () => json({ id: "ev2" }) });
  assertEquals((await moveCalendarEvent(admin, "m1", env(p.f))).status, "created");
  assertEquals(admin.tables.meetings[0].external_event_id, "ev2");
});

Deno.test("a cancel takes the event off and Microsoft sends the guest the cancellation", async () => {
  const admin = world({ conns: [conn("microsoft")], meeting: { status: "cancelled", external_event_id: "ev9", external_provider: "microsoft", calendar_invited: true } });
  const p = provider({ "POST https://graph.microsoft.com/v1.0/me/events/ev9/cancel": () => new Response(null, { status: 202 }) });
  assertEquals(await dropCalendarEvent(admin, "m1", env(p.f)), { status: "dropped" });
});

Deno.test("onBooked: a booking with nothing connected touches no provider at all", async () => {
  const admin = world({ conns: [] });
  const p = provider({});
  const out = await onBooked(admin, "m1", env(p.f));
  assertEquals(out.calendar.status, "skipped");
  assertEquals(p.calls.length, 0);
});

Deno.test("busy sync stores busy times, skips our own booking, and clears what is gone", async () => {
  const admin = world({ conns: [conn("google", { busy_calendar_ids: ["fam"] })] });
  admin.tables.meeting_busy.push({ host_id: "h1", provider: "google", external_id: "old", starts_at: "x", ends_at: "y", synced_at: "2026-10-01T00:00:00.000Z" });
  const p = provider({ "POST https://www.googleapis.com/calendar/v3/freeBusy": () => json({ calendars: {
    primary: { busy: [
      { start: "2026-11-03T15:30:00Z", end: "2026-11-03T16:00:00Z" }, // = our own booking m1
      { start: "2026-11-05T14:00:00Z", end: "2026-11-05T15:00:00Z" },
    ] },
    fam: { busy: [{ start: "2026-11-06T20:00:00Z", end: "2026-11-06T21:00:00Z" }] },
  } }) });
  const r = await syncConnectionBusy(admin, admin.tables.meeting_connections[0] as never, env(p.f));
  assertEquals(r, { ok: true, blocks: 2 });
  const rows = admin.tables.meeting_busy;
  assertEquals(rows.length, 2);
  assert(!rows.some((x) => x.external_id === "old"));
  assertEquals(JSON.parse(String(p.calls[0].init!.body)).items, [{ id: "primary" }, { id: "fam" }]);
});

Deno.test("the live check at booking: a clash refuses, a slow provider does not", async () => {
  const admin = world();
  const busy = provider({ "POST https://www.googleapis.com/calendar/v3/freeBusy": () => json({ calendars: { primary: { busy: [{ start: "2026-11-07T15:00:00Z", end: "2026-11-07T16:00:00Z" }] } } }) });
  assertEquals(await liveBusyCheck(admin, "h1", "2026-11-07T15:30:00.000Z", "2026-11-07T16:00:00.000Z", env(busy.f)), true);
  const down = provider({ "POST https://www.googleapis.com/calendar/v3/freeBusy": () => json({}, 503) });
  assertEquals(await liveBusyCheck(admin, "h1", "2026-11-07T15:30:00.000Z", "2026-11-07T16:00:00.000Z", env(down.f)), false);
});

Deno.test("the live check on a reschedule is not blocked by the booking's own old time", async () => {
  const admin = world();
  const p = provider({ "POST https://www.googleapis.com/calendar/v3/freeBusy": () => json({ calendars: { primary: { busy: [{ start: "2026-11-03T15:30:00Z", end: "2026-11-03T16:00:00Z" }] } } }) });
  assertEquals(await liveBusyCheck(admin, "h1", "2026-11-03T15:45:00.000Z", "2026-11-03T16:15:00.000Z", env(p.f), "m1"), false);
});
