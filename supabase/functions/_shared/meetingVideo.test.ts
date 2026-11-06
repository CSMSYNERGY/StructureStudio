// meetingVideo.test.ts — booking, moving and cancelling with a fresh Zoom link (migration 333).
//
// Driven against a tiny in-memory stand-in for the service-role client, with Zoom's HTTP
// answered by a stub. The cases that matter most: a link that cannot be made never fails the
// booking, the room link survives as the fallback, and two requests cannot both create a meeting.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { dropConference, ensureConference, moveConference, type VideoEnv } from "./meetingVideo.ts";

// ── a minimal PostgREST-shaped fake ──────────────────────────────────────────────────────
type Row = Record<string, unknown>;
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
function orFilter(expr: string) {
  const parts = splitTop(expr).map((p) => {
    const [col, op, ...rest] = p.split(".");
    const val = rest.join(".");
    return (r: Row) => {
      if (op === "is") return val === "null" ? r[col] == null : r[col] === (val === "true");
      if (op === "in") return val.replace(/[()]/g, "").split(",").includes(String(r[col]));
      if (op === "lt") return r[col] != null && String(r[col]) < val;
      if (op === "eq") return String(r[col]) === val;
      throw new Error("op " + op);
    };
  });
  return (r: Row) => parts.some((f) => f(r));
}
function fakeAdmin(tables: Record<string, Row[]>) {
  return {
    tables,
    from(name: string) {
      const rows = tables[name] ?? (tables[name] = []);
      const filters: ((r: Row) => boolean)[] = [];
      let op: "select" | "update" | "delete" = "select";
      let patch: Row = {};
      const b = {
        select() { return b; },
        update(p: Row) { op = "update"; patch = p; return b; },
        delete() { op = "delete"; return b; },
        eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return b; },
        is(c: string, v: unknown) { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
        in(c: string, v: unknown[]) { filters.push((r) => v.includes(r[c])); return b; },
        or(e: string) { filters.push(orFilter(e)); return b; },
        run() {
          const hit = rows.filter((r) => filters.every((f) => f(r)));
          if (op === "update") hit.forEach((r) => Object.assign(r, patch));
          if (op === "delete") hit.forEach((r) => rows.splice(rows.indexOf(r), 1));
          return hit;
        },
        maybeSingle() { const h = b.run(); return Promise.resolve({ data: h[0] ? { ...h[0] } : null, error: null }); },
        then(res: (v: unknown) => unknown) { const h = b.run(); return Promise.resolve({ data: h, error: null }).then(res); },
      };
      return b;
    },
  };
}

const NOW = Date.parse("2026-11-01T12:00:00Z");
const ENV_KEYS: Record<string, string> = { ZOOM_CLIENT_ID: "cid", ZOOM_CLIENT_SECRET: "cs" };

function world(opts: { mode?: string; roomUrl?: string | null; conn?: Row | null; meeting?: Row } = {}) {
  const meeting: Row = {
    id: "m1", client_id: "acme", host_id: "h1", status: "booked",
    starts_at: "2026-11-03T15:30:00.000Z", ends_at: "2026-11-03T16:00:00.000Z",
    conference_provider: "zoom", conference_url: opts.roomUrl ?? null, conference_note: null,
    conference_external_id: null, conference_status: null, conference_attempted_at: null, conference_error: null,
    meeting_types: { name: "Video consult", conference_mode: opts.mode ?? "generate", conference_provider: "zoom" },
    meeting_hosts: { time_zone: "America/Chicago" },
    ...(opts.meeting ?? {}),
  };
  const conn: Row | null = opts.conn === undefined
    ? { id: "c1", host_id: "h1", provider: "zoom", status: "connected", access_token: "A1", refresh_token: "R1", token_expires: "2026-11-01T13:00:00.000Z" }
    : opts.conn;
  return fakeAdmin({
    meetings: [meeting],
    meeting_connections: conn ? [conn] : [],
    client_settings: [{ client_id: "acme", business_name: "Acme Barns" }],
    client_configs: [],
  });
}

function zoom(routes: Record<string, (init?: RequestInit) => Response>) {
  const calls: { method: string; url: string; init?: RequestInit }[] = [];
  const f = (url: string, init?: RequestInit) => {
    const method = init?.method || "GET";
    calls.push({ method, url, init });
    const key = Object.keys(routes).find((k) => `${method} ${url}`.startsWith(k));
    if (!key) return Promise.resolve(new Response("{}", { status: 599 }));
    return Promise.resolve(routes[key](init));
  };
  return { f, calls };
}
const created = () => new Response(JSON.stringify({ id: 999, join_url: "https://zoom.us/j/999?pwd=x", password: "7788" }), { status: 201 });
const env = (f: VideoEnv["fetch"], keys = ENV_KEYS): VideoEnv => ({ get: (k) => keys[k], fetch: f, now: () => NOW });

Deno.test("a generate type with a connected host gets its own link, under the business's name", async () => {
  const admin = world({ roomUrl: "https://zoom.us/j/room" });
  const z = zoom({ "POST https://api.zoom.us/v2/users/me/meetings": created });
  const out = await ensureConference(admin, "m1", env(z.f));
  assertEquals(out, { status: "generated" });
  const m = admin.tables.meetings[0];
  assertEquals(m.conference_url, "https://zoom.us/j/999?pwd=x");
  assertEquals(m.conference_external_id, "999");
  assertEquals(m.conference_status, "generated");
  assertEquals(m.conference_note, "Passcode: 7788");
  const body = JSON.parse(String(z.calls[0].init!.body));
  assertEquals(body.topic, "Video consult with Acme Barns");
  assertEquals(body.timezone, "America/Chicago");
  assertEquals(body.duration, 30);
});

Deno.test("calling it again does not make a second meeting", async () => {
  const admin = world();
  const z = zoom({ "POST https://api.zoom.us/v2/users/me/meetings": created });
  await ensureConference(admin, "m1", env(z.f));
  const again = await ensureConference(admin, "m1", env(z.f));
  assertEquals(again, { status: "generated" });
  assertEquals(z.calls.length, 1);
});

Deno.test("another request already at Zoom: this one stands back", async () => {
  const admin = world({ meeting: { conference_status: "pending", conference_attempted_at: new Date(NOW - 10_000).toISOString() } });
  const z = zoom({ "POST https://api.zoom.us/v2/users/me/meetings": created });
  assertEquals(await ensureConference(admin, "m1", env(z.f)), { status: "pending", reason: "in_progress" });
  assertEquals(z.calls.length, 0);
});

Deno.test("a pending claim left by a request that died is taken over after two minutes", async () => {
  const admin = world({ meeting: { conference_status: "pending", conference_attempted_at: new Date(NOW - 5 * 60_000).toISOString() } });
  const z = zoom({ "POST https://api.zoom.us/v2/users/me/meetings": created });
  assertEquals(await ensureConference(admin, "m1", env(z.f)), { status: "generated" });
});

Deno.test("room-link types are left exactly as book_meeting() made them", async () => {
  const admin = world({ mode: "room", roomUrl: "https://zoom.us/j/room" });
  const z = zoom({});
  assertEquals((await ensureConference(admin, "m1", env(z.f))).status, "skipped");
  assertEquals(admin.tables.meetings[0].conference_status, null);
  assertEquals(z.calls.length, 0);
});

Deno.test("host not connected: the room link stays, the row says fallback", async () => {
  const admin = world({ conn: null, roomUrl: "https://zoom.us/j/room" });
  const out = await ensureConference(admin, "m1", env(zoom({}).f));
  assertEquals(out, { status: "fallback", reason: "not_connected" });
  assertEquals(admin.tables.meetings[0].conference_url, "https://zoom.us/j/room");
  assertEquals(admin.tables.meetings[0].conference_status, "fallback");
});

Deno.test("no connection and no room link: failed, so the email says a link will follow", async () => {
  const admin = world({ conn: null });
  const out = await ensureConference(admin, "m1", env(zoom({}).f));
  assertEquals(out, { status: "failed", reason: "not_connected" });
  assertEquals(admin.tables.meetings[0].conference_error, "not_connected");
});

Deno.test("before Carolyn adds the secrets: not_set_up, and Zoom is never called", async () => {
  const admin = world();
  const z = zoom({});
  assertEquals(await ensureConference(admin, "m1", env(z.f, {})), { status: "failed", reason: "not_set_up" });
  assertEquals(z.calls.length, 0);
});

Deno.test("an expired token is refreshed, and the ROTATED refresh token is stored", async () => {
  const admin = world({ conn: { id: "c1", host_id: "h1", provider: "zoom", status: "connected", access_token: "OLD", refresh_token: "R1", token_expires: "2026-11-01T11:00:00.000Z" } });
  const z = zoom({
    "POST https://zoom.us/oauth/token": () => new Response(JSON.stringify({ access_token: "A2", refresh_token: "R2", expires_in: 3600 }), { status: 200 }),
    "POST https://api.zoom.us/v2/users/me/meetings": created,
  });
  assertEquals(await ensureConference(admin, "m1", env(z.f)), { status: "generated" });
  const c = admin.tables.meeting_connections[0];
  assertEquals(c.refresh_token, "R2");
  assertEquals(c.access_token, "A2");
  assertEquals((z.calls[1].init!.headers as Record<string, string>).Authorization, "Bearer A2");
});

Deno.test("a revoked connection is marked for reconnecting; the booking still stands", async () => {
  const admin = world({
    roomUrl: "https://zoom.us/j/room",
    conn: { id: "c1", host_id: "h1", provider: "zoom", status: "connected", access_token: null, refresh_token: "R1", token_expires: null },
  });
  const z = zoom({ "POST https://zoom.us/oauth/token": () => new Response(JSON.stringify({ reason: "Invalid Token!" }), { status: 400 }) });
  assertEquals(await ensureConference(admin, "m1", env(z.f)), { status: "fallback", reason: "needs_reconnect" });
  assertEquals(admin.tables.meeting_connections[0].status, "needs_reauth");
  assertEquals(admin.tables.meetings[0].status, "booked");
});

Deno.test("a 401 on a token we thought was good: refresh once and retry", async () => {
  const admin = world();
  let first = true;
  const z = zoom({
    "POST https://api.zoom.us/v2/users/me/meetings": () => {
      if (first) { first = false; return new Response("{}", { status: 401 }); }
      return created();
    },
    "POST https://zoom.us/oauth/token": () => new Response(JSON.stringify({ access_token: "A2", refresh_token: "R2", expires_in: 3600 }), { status: 200 }),
  });
  assertEquals(await ensureConference(admin, "m1", env(z.f)), { status: "generated" });
});

Deno.test("Zoom down: failed with provider_error, never a thrown booking", async () => {
  const admin = world();
  const z = zoom({ "POST https://api.zoom.us/v2/users/me/meetings": () => new Response("{}", { status: 503 }) });
  assertEquals(await ensureConference(admin, "m1", env(z.f)), { status: "failed", reason: "provider_error" });
});

Deno.test("a reschedule moves the Zoom meeting", async () => {
  const admin = world({ meeting: { conference_external_id: "999", conference_url: "https://zoom.us/j/999", conference_status: "generated" } });
  const z = zoom({ "PATCH https://api.zoom.us/v2/meetings/999": () => new Response(null, { status: 204 }) });
  assertEquals(await moveConference(admin, "m1", env(z.f)), { status: "moved" });
  assertEquals(JSON.parse(String(z.calls[0].init!.body)).start_time, "2026-11-03T15:30:00Z");
});

Deno.test("moving a meeting someone deleted in Zoom makes a new one instead of sending a dead link", async () => {
  const admin = world({ meeting: { conference_external_id: "999", conference_url: "https://zoom.us/j/999", conference_status: "generated" } });
  const z = zoom({
    "PATCH https://api.zoom.us/v2/meetings/999": () => new Response("{}", { status: 404 }),
    "POST https://api.zoom.us/v2/users/me/meetings": () => new Response(JSON.stringify({ id: 1000, join_url: "https://zoom.us/j/1000" }), { status: 201 }),
  });
  assertEquals(await moveConference(admin, "m1", env(z.f)), { status: "generated" });
  assertEquals(admin.tables.meetings[0].conference_url, "https://zoom.us/j/1000");
});

Deno.test("a reschedule is another chance for a meeting that never got its link", async () => {
  const admin = world({ meeting: { conference_status: "failed", conference_error: "not_connected" } });
  const z = zoom({ "POST https://api.zoom.us/v2/users/me/meetings": created });
  assertEquals(await moveConference(admin, "m1", env(z.f)), { status: "generated" });
});

Deno.test("a cancel deletes the meeting we made, and only that", async () => {
  const admin = world({ meeting: { status: "cancelled", conference_external_id: "999" } });
  const z = zoom({ "DELETE https://api.zoom.us/v2/meetings/999": () => new Response(null, { status: 204 }) });
  assertEquals(await dropConference(admin, "m1", env(z.f)), { status: "dropped" });
  const room = world({ meeting: { status: "cancelled" }, roomUrl: "https://zoom.us/j/room" });
  const z2 = zoom({});
  assertEquals((await dropConference(room, "m1", env(z2.f))).status, "skipped");
  assert(z2.calls.length === 0);
});

Deno.test("a booking cancelled while Zoom was answering leaves no room behind", async () => {
  const admin = world();
  const z = zoom({
    "POST https://api.zoom.us/v2/users/me/meetings": () => {
      admin.tables.meetings[0].status = "cancelled"; // lands mid-call
      return created();
    },
    "DELETE https://api.zoom.us/v2/meetings/999": () => new Response(null, { status: 204 }),
  });
  assertEquals(await ensureConference(admin, "m1", env(z.f)), { status: "skipped", reason: "not_booked" });
  assert(z.calls.some((c) => c.method === "DELETE"));
});
