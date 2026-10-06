// Test harness: a fake network (Supabase PostgREST + Auth, Twilio, Google, Apple), a signed-in
// user with a real ES256 key pair, and signed Twilio webhook requests.
//
// ⚠️ PUBLIC REPO: every value here is obviously fake (555-01xx numbers, all-zero SIDs,
// example.test hosts, "demo-tenant"). Never paste a real one.

import { vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { b64urlEncode, b64urlEncodeString } from "../src/b64";
import { computeTwilioSignature } from "../src/twilioSignature";

export const SUPABASE_URL = "https://demo-project.supabase.example.test";
export const BASE = "https://phone.example.test";
export const WEBHOOK_KEY = "test-webhook-key";
export const AUTH_TOKEN = "test-auth-token";
export const CLIENT = "demo-tenant";
export const BUSINESS_NUMBER = "+15555550100";
export const NUMBER_ID = "00000000-0000-4000-8000-00000000a001";
export const USER_A = "00000000-0000-4000-8000-0000000000a1";
export const USER_B = "00000000-0000-4000-8000-0000000000b2";
export const USER_C = "00000000-0000-4000-8000-0000000000c3";
export const CONTACT_1 = "00000000-0000-4000-8000-00000000c001";
export const CONTACT_2 = "00000000-0000-4000-8000-00000000c002";
export const CUSTOMER = "+15555550142";
export const CALL_SID = "CA" + "0".repeat(31) + "1";

export function makeEnv(over: Partial<Env> = {}): Env {
  return {
    PUBLIC_BASE_URL: BASE,
    EMERGENCY_MODE: "block",
    DAILY_MINUTE_CAP: "600",
    EXTENSION_ORIGINS: "abcdefghijklmnopabcdefghijklmnop",
    PHONE_USAGE_METERS: "off",
    // wrangler.jsonc ships "on". Off here so the tick and daily-cron tests that are not about
    // billing do not run the usage charges against a fake network with no routes for them;
    // test/usageCharge.test.ts turns it on.
    PHONE_USAGE_COST_CAPTURE: "off",
    VOICEMAIL_RETENTION_DAYS: "365",
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
    TWILIO_ACCOUNT_SID: "AC" + "0".repeat(32),
    TWILIO_AUTH_TOKEN: AUTH_TOKEN,
    TWILIO_API_KEY: "SK" + "0".repeat(32),
    TWILIO_API_SECRET: "test-api-secret",
    TWILIO_TWIML_APP_SID: "AP" + "0".repeat(31) + "1",
    TWILIO_ECHO_APP_SID: "AP" + "0".repeat(31) + "2",
    TWILIO_PUSH_CREDENTIAL_APNS_DEV: "CR" + "0".repeat(31) + "1",
    TWILIO_PUSH_CREDENTIAL_APNS_PROD: "CR" + "0".repeat(31) + "2",
    TWILIO_PUSH_CREDENTIAL_FCM: "CR" + "0".repeat(31) + "3",
    PHONE_WEBHOOK_SECRET: WEBHOOK_KEY,
    SMS_INBOUND_SECRET: "test-sms-secret",
    PUSH_WEBHOOK_SECRET: "test-push-secret",
    ...over,
  };
}

// ── waitUntil ───────────────────────────────────────────────────────────────────────

export class FakeCtx {
  pending: Promise<unknown>[] = [];
  waitUntil(p: Promise<unknown>): void {
    this.pending.push(p);
  }
  passThroughOnException(): void {}
  props = {};
  /** Wait for every background task, including ones scheduled by background tasks. */
  async settle(): Promise<void> {
    let seen = 0;
    while (seen < this.pending.length) {
      const batch = this.pending.slice(seen);
      seen = this.pending.length;
      await Promise.allSettled(batch);
    }
  }
}

// ── The fake network ────────────────────────────────────────────────────────────────

export interface Seen {
  method: string;
  url: URL;
  headers: Headers;
  body: string;
  json: any;
}

type Reply = (req: Seen) => unknown | Response | Promise<unknown | Response>;

interface Route {
  method: string;
  test: (u: URL) => boolean;
  reply: Reply;
  kind: "rest" | "rpc" | "raw";
}

export class FakeNet {
  routes: Route[] = [];
  seen: Seen[] = [];
  unmatched: Seen[] = [];

  /** A PostgREST table. The reply returns ROWS (an array); the harness shapes the response. */
  rest(method: string, table: string, reply: Reply): this {
    this.routes.push({ method, kind: "rest", test: (u) => u.origin === SUPABASE_URL && u.pathname === `/rest/v1/${table}`, reply });
    return this;
  }

  rpc(name: string, reply: Reply): this {
    this.routes.push({ method: "POST", kind: "rpc", test: (u) => u.origin === SUPABASE_URL && u.pathname === `/rest/v1/rpc/${name}`, reply });
    return this;
  }

  on(method: string, test: RegExp | ((u: URL) => boolean), reply: Reply): this {
    const t = typeof test === "function" ? test : (u: URL) => test.test(u.href);
    this.routes.push({ method, kind: "raw", test: t, reply });
    return this;
  }

  /** Writes to a table, parsed. */
  writes(table: string, method?: string): Seen[] {
    return this.seen.filter((s) => s.url.pathname === `/rest/v1/${table}` && s.method !== "GET" && (!method || s.method === method));
  }

  reads(table: string): Seen[] {
    return this.seen.filter((s) => s.url.pathname === `/rest/v1/${table}` && s.method === "GET");
  }

  rpcCalls(name: string): Seen[] {
    return this.seen.filter((s) => s.url.pathname === `/rest/v1/rpc/${name}`);
  }

  to(pattern: RegExp): Seen[] {
    return this.seen.filter((s) => pattern.test(s.url.href));
  }

  install(): this {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(req.url);
      const body = req.method === "GET" || req.method === "HEAD" ? "" : await req.text();
      let parsed: any = null;
      try { parsed = body ? JSON.parse(body) : null; } catch { parsed = null; }
      const s: Seen = { method: req.method, url, headers: req.headers, body, json: parsed };
      this.seen.push(s);
      // Last registered wins, so a test can override a default.
      for (let i = this.routes.length - 1; i >= 0; i--) {
        const r = this.routes[i];
        if (r.method !== "*" && r.method !== req.method) continue;
        if (!r.test(url)) continue;
        const out = await r.reply(s);
        if (out instanceof Response) return out;
        if (r.kind === "rpc") return jsonRes(out ?? null);
        if (r.kind === "rest") return restResponse(s, out);
        return jsonRes(out ?? {});
      }
      this.unmatched.push(s);
      return new Response(JSON.stringify({ message: `unmatched ${req.method} ${url.pathname}` }), { status: 500, headers: { "content-type": "application/json" } });
    });
    return this;
  }
}

export function jsonRes(v: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...headers } });
}

function restResponse(s: Seen, out: unknown): Response {
  const rows = out === undefined ? [] : Array.isArray(out) ? out : [out];
  const wantsObject = (s.headers.get("accept") ?? "").includes("vnd.pgrst.object+json");
  const representation = (s.headers.get("prefer") ?? "").includes("return=representation");
  if (s.method !== "GET" && !representation) return new Response(null, { status: s.method === "POST" ? 201 : 204 });
  if (wantsObject) {
    if (rows.length !== 1) {
      return jsonRes({ code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned", details: `${rows.length} rows` }, 406);
    }
    return jsonRes(rows[0]);
  }
  return jsonRes(rows);
}

/** One phone_call_events row as the Worker reads it back. */
export interface EventFixture {
  call_id: string;
  type: string;
  at: string;
  data: Record<string, unknown> | null;
}

/** The values an eq./in.() filter asks for, or null when there is no such filter. */
function filterValues(v: string | null): string[] | null {
  if (!v) return null;
  if (v.startsWith("eq.")) return [v.slice(3)];
  const m = /^in\.\((.*)\)$/.exec(v);
  return m ? m[1].split(",").map((x) => x.replace(/^"|"$/g, "")) : null;
}

/** A phone_call_events GET reply that honours the call_id and type filters the Worker sends. */
export function eventRows(rows: EventFixture[]): Reply {
  return (s: Seen) => {
    const ids = filterValues(s.url.searchParams.get("call_id"));
    const types = filterValues(s.url.searchParams.get("type"));
    return rows.filter((r) => (!ids || ids.includes(r.call_id)) && (!types || types.includes(r.type)));
  };
}

/** A PostgREST filter value from a request, e.g. eq("id") → the id asked for. */
export function filter(s: Seen, col: string): string | null {
  const v = s.url.searchParams.get(col);
  if (!v) return null;
  const i = v.indexOf(".");
  return i === -1 ? v : v.slice(i + 1);
}

// ── Logins (ES256, like the project's) ──────────────────────────────────────────────

let kidSeq = 0;

export class Auth {
  /** Unique per instance, as a real key rotation would be. */
  kid = `test-kid-${++kidSeq}`;
  keys!: CryptoKeyPair;
  jwk!: JsonWebKey;

  async init(): Promise<this> {
    this.keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    this.jwk = (await crypto.subtle.exportKey("jwk", this.keys.publicKey)) as JsonWebKey;
    return this;
  }

  jwks() {
    return { keys: [{ ...this.jwk, kid: this.kid, alg: "ES256", use: "sig" }] };
  }

  async token(userId: string, over: Record<string, unknown> = {}, header: Record<string, unknown> = {}): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      sub: userId, aud: "authenticated", role: "authenticated", iss: `${SUPABASE_URL}/auth/v1`,
      iat: now, exp: now + 3600, session_id: "00000000-0000-4000-8000-000000005e55", ...over,
    };
    const input = `${b64urlEncodeString(JSON.stringify({ alg: "ES256", typ: "JWT", kid: this.kid, ...header }))}.${b64urlEncodeString(JSON.stringify(claims))}`;
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.keys.privateKey, new TextEncoder().encode(input));
    return `${input}.${b64urlEncode(sig)}`;
  }

  /** Serve the JWKS and a live session on the fake network. */
  serve(net: FakeNet): this {
    net.on("GET", (u) => u.href === `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`, () => this.jwks());
    net.on("GET", (u) => u.href === `${SUPABASE_URL}/auth/v1/user`, () => ({ id: "ok" }));
    return this;
  }
}

// ── Caller context and routes ───────────────────────────────────────────────────────

export function callerCtx(over: Record<string, unknown> = {}) {
  return {
    client_id: CLIENT,
    phone_status: "on",
    phone_level: "own",
    contacts_level: "edit",
    own_contacts_only: false,
    device_generation: 1,
    number: { id: NUMBER_ID, e164: BUSINESS_NUMBER, voice_enabled: true, registration_status: "registered" },
    full_name: "Test Person",
    ...over,
  };
}

export function member(userId: string, over: Record<string, unknown> = {}) {
  return {
    user_id: userId,
    identity: `u_${userId.replace(/-/g, "")}_g1`,
    dnd: false,
    busy: false,
    has_access: true,
    full_name: "Member",
    forward_to_cell: null,
    ...over,
  };
}

export function routeInfo(over: Record<string, unknown> = {}, route: Record<string, unknown> = {}) {
  return {
    client_id: CLIENT,
    number_id: NUMBER_ID,
    phone_status: "on",
    route: {
      mode: "all_at_once",
      members: [USER_A, USER_B, USER_C],
      ring_seconds: 20,
      no_answer: "voicemail",
      forward_to: null,
      business_hours: null,
      time_zone: "America/Chicago",
      after_hours: "voicemail",
      greeting_url: null,
      ...route,
    },
    members: [member(USER_A), member(USER_B), member(USER_C)],
    business_name: "Demo Sheds",
    recent_emergency_user: null,
    ...over,
  };
}

// ── Requests ────────────────────────────────────────────────────────────────────────

export async function twilioPost(
  env: Env,
  path: string,
  params: Record<string, string>,
  query: Record<string, string> = {},
  opts: { key?: string; signWith?: string; tamper?: boolean } = {},
): Promise<Request> {
  const q = new URLSearchParams({ ...query, key: opts.key ?? WEBHOOK_KEY });
  const url = `${BASE}${path}?${q}`;
  const pairs = Object.entries(params);
  const sig = await computeTwilioSignature(opts.signWith ?? AUTH_TOKEN, url, pairs);
  const body = new URLSearchParams(params);
  if (opts.tamper) body.set("To", "+15555550199");
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sig },
    body: body.toString(),
  });
}

export function appRequest(method: string, path: string, token: string | null, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

export async function call(env: Env, req: Request, ctx = new FakeCtx()): Promise<{ res: Response; text: string; json: any; ctx: FakeCtx }> {
  const res = await worker.fetch(req, env, ctx as unknown as ExecutionContext);
  const text = await res.clone().text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  await ctx.settle();
  return { res, text, json: parsed, ctx };
}

/** Pull the <Dial> nouns out of a TwiML string, for assertions. */
export function clientsIn(xml: string): string[] {
  return [...xml.matchAll(/<Identity>([^<]+)<\/Identity>/g)].map((m) => m[1]);
}
export function numbersIn(xml: string): string[] {
  return [...xml.matchAll(/<Number[^>]*>([^<]+)<\/Number>/g)].map((m) => m[1]);
}
export function attr(xml: string, tag: string, name: string): string | null {
  const m = new RegExp(`<${tag}\\b[^>]*\\s${name}="([^"]*)"`).exec(xml);
  return m ? m[1].replace(/&amp;/g, "&") : null;
}
