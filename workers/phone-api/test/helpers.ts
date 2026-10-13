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

// ── A table that answers the way PostgREST would (list search, 2026-10-13) ──────────
// Honours what the Worker sends: eq, lt, gte, is.null, not.is.null, in, cs, like and ilike;
// `or` (and `and(...)` / `or(...)` nested inside it); filters on an embedded table
// (`crm_contacts.name=ilike.*jo*`), which with `!inner` in the select drop the parent row; and
// order, offset and limit. Rows carry their embeds as plain keys (crm_contacts, phone_voicemails).
// Rows the Worker must never see (another tenant's, a deleted voicemail) sit in the fixtures, so
// a filter it forgets shows up as a wrong answer, not as a passing test.

/** Split on the commas that are not inside parentheses or quotes. */
export function splitTop(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted && ch === "\\") { cur += ch + s[++i]; continue; }
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === "(") depth++;
    else if (!quoted && ch === ")") depth--;
    else if (!quoted && ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

const unquoteValue = (v: string) => (v.startsWith('"') ? v.slice(1, -1).replace(/\\(.)/g, "$1") : v);

/** One PostgREST operator against one value. */
export function pgHolds(val: unknown, expr: string): boolean {
  if (expr === "is.null") return val == null;
  if (expr === "not.is.null") return val != null;
  const i = expr.indexOf(".");
  const op = expr.slice(0, i);
  const arg = expr.slice(i + 1);
  if (op === "eq") return val != null && String(val) === arg;
  if (op === "lt") return val != null && String(val) < arg;
  if (op === "gte") return val != null && String(val) >= arg;
  if (op === "in") return val != null && splitTop(arg.slice(1, -1)).map(unquoteValue).includes(String(val));
  if (op === "cs") return Array.isArray(val) && arg.slice(1, -1).split(",").every((x) => (val as unknown[]).map(String).includes(x));
  if (op === "like" || op === "ilike") {
    // PostgREST's * is SQL's %; _ is any one character.
    const re = [...arg].map((ch) => (ch === "*" || ch === "%" ? ".*" : ch === "_" ? "." : ch.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))).join("");
    return val != null && new RegExp(`^${re}$`, op === "ilike" ? "is" : "s").test(String(val));
  }
  throw new Error(`pgTable(): the fake has no "${op}" filter`);
}

/** `a.op.v`, `and(...)` or `or(...)` against a row. */
function pgExpr(row: Record<string, unknown>, part: string): boolean {
  if (part.startsWith("and(")) return splitTop(part.slice(4, -1)).every((p) => pgExpr(row, p));
  if (part.startsWith("or(")) return splitTop(part.slice(3, -1)).some((p) => pgExpr(row, p));
  const dot = part.indexOf(".");
  return pgHolds(row[part.slice(0, dot)], part.slice(dot + 1));
}

export function pgTable(rows: Record<string, unknown>[]) {
  return (s: Seen) => {
    const p = s.url.searchParams;
    const select = p.get("select") ?? "*";
    const embedded = (name: string) => select.includes(`${name}!inner(`) ? "inner" : select.includes(`${name}(`) ? "left" : null;
    let out: Record<string, unknown>[] = [];
    for (const r of rows) {
      const row: Record<string, unknown> = { ...r };
      let keep = true;
      for (const [k, v] of p.entries()) {
        if (k === "select" || k === "order" || k === "limit" || k === "offset") continue;
        if (k === "or") { if (!splitTop(v.slice(1, -1)).some((part) => pgExpr(row, part))) keep = false; continue; }
        const dot = k.indexOf(".");
        if (dot > 0) {
          // A filter on an embedded table: narrows the embed; with !inner an empty embed drops the row.
          const name = k.slice(0, dot);
          const col = k.slice(dot + 1);
          const how = embedded(name);
          if (!how) throw new Error(`pgTable(): ${k} filters ${name}, which the select does not embed`);
          if (how !== "inner") throw new Error(`pgTable(): ${k} filters a left-joined ${name}; the Worker only filters inner joins`);
          const e = row[name];
          const list = (Array.isArray(e) ? e : e ? [e] : []) as Record<string, unknown>[];
          const kept = list.filter((x) => pgHolds(x[col], v));
          row[name] = Array.isArray(e) ? kept : kept[0] ?? null;
          if (!kept.length) keep = false;
          continue;
        }
        if (!pgHolds(row[k], v)) keep = false;
      }
      // An !inner embed with nothing to join drops the row even without a filter on it.
      for (const name of ["crm_contacts", "phone_voicemails", "phone_call_recordings"]) {
        if (embedded(name) === "inner") {
          const e = row[name];
          if (e == null || (Array.isArray(e) && !e.length)) keep = false;
        }
      }
      if (keep) out.push(row);
    }
    const order = p.get("order");
    if (order) {
      const keys = order.split(",").map((o) => {
        const [col, dir, nulls] = o.split(".");
        return { col, sign: dir === "desc" ? -1 : 1, nullsFirst: nulls === "nullsfirst" };
      });
      out = [...out].sort((a, b) => {
        for (const { col, sign, nullsFirst } of keys) {
          const x = a[col], y = b[col];
          if (x == null || y == null) {
            if (x == null && y == null) continue;
            return (x == null) === nullsFirst ? -1 : 1;
          }
          if (String(x) !== String(y)) return String(x) < String(y) ? -sign : sign;
        }
        return 0;
      });
    }
    const offset = p.get("offset");
    if (offset) out = out.slice(Number(offset));
    const limit = p.get("limit");
    if (limit) out = out.slice(0, Number(limit));
    if (select === "*") return out;
    // Only the columns asked for (an embed whole), so a column the Worker forgets to select is
    // missing here as it would be live.
    const cols = splitTop(select).map((c) => c.trim()).map((c) => (c.includes("(") ? c.slice(0, c.indexOf("(")).replace(/!inner$/, "") : c));
    return out.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null])));
  };
}

// ── Migration 305's search function, as the Worker's rpc meets it (2026-10-13) ──────
// public.phone_list_search in JS, over the same fixture rows pgTable serves: what
// tests/sql/migration305.test.cjs proves the SQL does (PGlite), kind by kind. The term is matched
// as itself (LIKE's `%`, `_` and `\` escaped), case aside; under 2 characters finds nothing; only
// p_client_id's rows; a call's contact and voicemail are its embeds (crm_contacts,
// phone_voicemails), and a deleted voicemail is no voicemail.

type FixtureRow = Record<string, unknown>;
const oneOf = (v: unknown): FixtureRow | null => (Array.isArray(v) ? (v[0] as FixtureRow) ?? null : (v as FixtureRow) ?? null);
const timeOf = (v: unknown) => Date.parse(String(v));
/** Newest first by `col`, ties by id (the function's order). */
const newestBy = (col: string) => (a: FixtureRow, b: FixtureRow) =>
  timeOf(b[col]) - timeOf(a[col]) || (String(a.id) < String(b.id) ? 1 : String(a.id) > String(b.id) ? -1 : 0);
const pick = (r: FixtureRow, cols: string[]) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null]));

export function phoneListSearch(w: { sms?: FixtureRow[]; contacts?: FixtureRow[]; calls?: FixtureRow[] }): Reply {
  return (s: Seen) => {
    const a = (s.json ?? {}) as Record<string, any>;
    const client = String(a.p_client_id ?? "").trim();
    if (!client) return jsonRes({ code: "22004", message: "phone_list_search: a tenant is required" }, 400);
    const raw = String(a.p_term ?? "").trim();
    const term = raw.length >= 2 ? raw.slice(0, 60).toLowerCase() : null;
    const digits = typeof a.p_digits === "string" && /^[0-9]{3,60}$/.test(a.p_digits) ? a.p_digits : null;
    const limit = Math.min(Math.max(Number(a.p_limit ?? 50) || 50, 1), 1000);
    const before = a.p_before ? timeOf(a.p_before) : null;
    const after = a.p_after ? timeOf(a.p_after) : null;
    const holds = (v: unknown) => term !== null && v != null && String(v).toLowerCase().includes(term);
    const has = (v: unknown, d: string | null) => d !== null && v != null && String(v).includes(d);
    const mineOf = (r: FixtureRow) => r.client_id === client;
    const kind = String(a.p_kind ?? "");

    if (kind === "texts") {
      return (w.sms ?? []).filter(mineOf)
        .filter((m) => holds(m.body) || (m.direction === "in" ? has(m.from_number, digits) : has(m.to_number, digits)))
        .sort(newestBy("created_at")).slice(0, limit)
        .map((m) => pick(m, ["id", "contact_id", "direction", "body", "created_at", "from_number", "to_number"]));
    }
    if (kind === "contacts" || kind === "directory" || kind === "directory_email") {
      const cc = kind === "contacts" && digits?.startsWith("1") ? digits.slice(1) : null;
      return (w.contacts ?? []).filter(mineOf).filter((k) => k.merged_into == null)
        .filter((k) => (kind === "directory_email"
          ? holds(k.email_lower)
          : holds(k.name) || has(k.phone_digits, digits) || (cc !== null && String(k.phone_digits ?? "").startsWith(cc))))
        .sort(newestBy("updated_at")).slice(0, limit)
        .map((k) => (kind === "contacts" ? { id: k.id } : pick(k, ["id", "name", "phone", "phone_digits", "email"])));
    }
    if (kind === "conversations") {
      const ids = new Set((a.p_ids ?? []) as string[]);
      const nums = new Set(((a.p_numbers ?? []) as string[]).filter(Boolean));
      if (!ids.size && !nums.size) return [];
      return (w.sms ?? []).filter(mineOf)
        .filter((m) => ids.has(String(m.contact_id)) || (m.contact_id == null && (nums.has(String(m.from_number)) || nums.has(String(m.to_number)))))
        .filter((m) => (before === null || timeOf(m.created_at) < before) && (after === null || timeOf(m.created_at) >= after))
        .sort(newestBy("created_at")).slice(0, limit)
        .map((m) => pick(m, ["id", "contact_id", "direction", "body", "status", "created_at", "from_number", "to_number", "sent_by"]));
    }
    if (kind === "calls") {
      const customers = a.p_customers !== false;
      const user = (a.p_user_id ?? null) as string | null;
      return (w.calls ?? []).filter(mineOf).filter((r) => {
        const contact = r.contact_id ? oneOf(r.crm_contacts) : null;
        const vm = oneOf(r.phone_voicemails);
        const voicemail = vm && !vm.deleted_at ? vm : null;
        const matches = (customers && holds(contact?.name))
          || (r.direction === "in" ? has(r.from_e164, digits) : has(r.to_e164, digits))
          || holds(voicemail?.transcript);
        if (!matches) return false;
        if (a.p_voicemail === true && !voicemail) return false;
        if (before !== null && !(timeOf(r.started_at) < before)) return false;
        if (user === null) return true;
        return r.placed_by === user || r.answered_by === user || r.transferred_from === user
          || ((r.rang_user_ids ?? []) as string[]).includes(user)
          || (customers && contact?.owner_user_id === user && ["missed", "voicemail", "ringing"].includes(String(r.status)));
      }).sort(newestBy("started_at")).slice(0, limit).map((r) => ({ id: r.id, started_at: r.started_at }));
    }
    return jsonRes({ code: "22023", message: `phone_list_search: unknown kind ${kind}` }, 400);
  };
}

/** Every Supabase request a test made, as a URL: what Supabase's API request logs would keep. */
export function supabaseUrls(net: FakeNet): string[] {
  return net.seen.filter((s) => s.url.origin === SUPABASE_URL).map((s) => decodeURIComponent(s.url.href));
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
