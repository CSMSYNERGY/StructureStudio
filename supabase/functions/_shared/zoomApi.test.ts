// zoomApi.test.ts — the Zoom calls behind "a fresh link per booking" (migration 333).
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ZoomError,
  zoomAuthorizeUrl,
  zoomCreateMeeting,
  zoomCredsFromEnv,
  zoomDeleteMeeting,
  zoomRefresh,
  zoomTime,
  zoomUrlValidation,
  zoomVerifyWebhook,
} from "./zoomApi.ts";

const CREDS = { clientId: "cid", clientSecret: "csecret" };

Deno.test("no secrets means the feature is dark, not half-configured", () => {
  assertEquals(zoomCredsFromEnv(() => undefined), null);
  assertEquals(zoomCredsFromEnv((k) => (k === "ZOOM_CLIENT_ID" ? "x" : undefined)), null);
  assertEquals(zoomCredsFromEnv((k) => (k.startsWith("ZOOM_CLIENT") ? " v " : undefined)), { clientId: "v", clientSecret: "v" });
});

Deno.test("authorize URL carries our redirect and state, and never the secret", () => {
  const u = new URL(zoomAuthorizeUrl(CREDS, "https://x.supabase.co/functions/v1/meetings-oauth-callback", "S".repeat(40)));
  assertEquals(u.origin + u.pathname, "https://zoom.us/oauth/authorize");
  assertEquals(u.searchParams.get("client_id"), "cid");
  assertEquals(u.searchParams.get("state"), "S".repeat(40));
  assertEquals(u.searchParams.get("response_type"), "code");
  assert(!u.toString().includes("csecret"));
});

Deno.test("Zoom times are UTC with no milliseconds", () => {
  assertEquals(zoomTime("2026-11-03T15:30:00.000Z"), "2026-11-03T15:30:00Z");
  assertEquals(zoomTime("2026-11-03T09:30:00-06:00"), "2026-11-03T15:30:00Z");
});

Deno.test("a create sends a scheduled meeting with a waiting room and returns the join link", async () => {
  let sent: { url: string; init?: RequestInit } | null = null;
  const f = (url: string, init?: RequestInit) => {
    sent = { url, init };
    return Promise.resolve(new Response(JSON.stringify({ id: 81234567890, join_url: "https://us06web.zoom.us/j/81234567890?pwd=abc", password: "4120" }), { status: 201 }));
  };
  const m = await zoomCreateMeeting("TOKEN", { topic: "Site visit with Cedar Ridge", startsAt: "2026-11-03T15:30:00.000Z", durationMinutes: 30, timeZone: "America/Chicago" }, f);
  assertEquals(m, { id: "81234567890", joinUrl: "https://us06web.zoom.us/j/81234567890?pwd=abc", password: "4120" });
  assertEquals(sent!.url, "https://api.zoom.us/v2/users/me/meetings");
  assertEquals((sent!.init!.headers as Record<string, string>).Authorization, "Bearer TOKEN");
  const body = JSON.parse(String(sent!.init!.body));
  assertEquals(body.type, 2);
  assertEquals(body.start_time, "2026-11-03T15:30:00Z");
  assertEquals(body.duration, 30);
  assertEquals(body.settings.waiting_room, true);
});

Deno.test("a join link that is not https never comes back", async () => {
  const f = () => Promise.resolve(new Response(JSON.stringify({ id: 1, join_url: "javascript:alert(1)" }), { status: 201 }));
  const e = await assertRejects(() => zoomCreateMeeting("T", { topic: "x", startsAt: "2026-11-03T15:30:00Z", durationMinutes: 30, timeZone: "UTC" }, f), ZoomError);
  assertEquals((e as ZoomError).code, "provider_error");
});

Deno.test("statuses map to codes we can store; Zoom's text never travels", async () => {
  const make = (status: number, body: unknown) => () => Promise.resolve(new Response(JSON.stringify(body), { status }));
  const input = { topic: "x", startsAt: "2026-11-03T15:30:00Z", durationMinutes: 30, timeZone: "UTC" };
  for (const [status, code] of [[401, "unauthorized"], [429, "rate_limited"], [503, "provider_error"], [400, "refused"]] as const) {
    const e = await assertRejects(() => zoomCreateMeeting("T", input, make(status, { message: "secret detail" })), ZoomError);
    assertEquals((e as ZoomError).code, code);
    assert(!(e as Error).message.includes("secret detail"));
  }
});

Deno.test("a network failure is provider_error, not an exception that escapes", async () => {
  const f = () => Promise.reject(new TypeError("connection reset"));
  const e = await assertRejects(() => zoomRefresh(CREDS, "R", f), ZoomError);
  assertEquals((e as ZoomError).code, "provider_error");
});

Deno.test("refresh posts the refresh token with Basic auth and returns the ROTATED one", async () => {
  let init: RequestInit | undefined;
  const f = (_u: string, i?: RequestInit) => {
    init = i;
    return Promise.resolve(new Response(JSON.stringify({ access_token: "A2", refresh_token: "R2", expires_in: 3600 }), { status: 200 }));
  };
  const t = await zoomRefresh(CREDS, "R1", f, Date.parse("2026-11-01T00:00:00Z"));
  assertEquals(t, { accessToken: "A2", refreshToken: "R2", expiresAt: "2026-11-01T01:00:00.000Z" });
  assertEquals((init!.headers as Record<string, string>).Authorization, "Basic " + btoa("cid:csecret"));
  assert(String(init!.body).includes("refresh_token=R1"));
});

Deno.test("a dead refresh token reads as invalid_grant", async () => {
  const f = () => Promise.resolve(new Response(JSON.stringify({ reason: "Invalid Token!", error: "invalid_request" }), { status: 400 }));
  const e = await assertRejects(() => zoomRefresh(CREDS, "R", f), ZoomError);
  assertEquals((e as ZoomError).code, "invalid_grant");
});

Deno.test("deleting a meeting Zoom no longer has counts as done", async () => {
  await zoomDeleteMeeting("T", "123", () => Promise.resolve(new Response(null, { status: 404 })));
  await zoomDeleteMeeting("T", "123", () => Promise.resolve(new Response(null, { status: 204 })));
});

Deno.test("webhook signatures: good passes, tampered and stale fail", async () => {
  const secret = "whsec";
  const body = '{"event":"app_deauthorized"}';
  const now = Date.parse("2026-11-01T12:00:00Z");
  const ts = String(Math.floor(now / 1000));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const raw = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${ts}:${body}`));
  const sig = "v0=" + Array.from(new Uint8Array(raw)).map((b) => b.toString(16).padStart(2, "0")).join("");
  assert(await zoomVerifyWebhook(secret, ts, sig, body, now));
  assert(!(await zoomVerifyWebhook(secret, ts, sig, body + " ", now)));
  assert(!(await zoomVerifyWebhook("other", ts, sig, body, now)));
  assert(!(await zoomVerifyWebhook(secret, ts, sig, body, now + 10 * 60_000)));
  assert(!(await zoomVerifyWebhook(secret, null, sig, body, now)));
});

Deno.test("url validation answers with the HMAC of the plain token", async () => {
  const out = await zoomUrlValidation("whsec", "abc");
  assertEquals(out.plainToken, "abc");
  assertEquals(out.encryptedToken.length, 64);
});
