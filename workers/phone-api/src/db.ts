// Database access: one service-role supabase-js client per isolate, and the two phone RPCs.
//
// The service role is BYPASSRLS, so NOTHING here is filtered by RLS. Every read that reaches a
// customer's rows is narrowed by hand in scope.ts, the same posture portal-settings takes
// (its ROW SCOPE comment explains why the 193 policies do nothing on the edge).

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "./env";
import { logFault } from "./log";

export type Admin = SupabaseClient;
export type Level = "none" | "own" | "view" | "edit";

let cached: { url: string; key: string; client: Admin } | null = null;

export function adminClient(env: Env): Admin {
  const url = env.SUPABASE_URL || "";
  const key = env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!url || !key) throw new DbError("config", "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set");
  if (cached && cached.url === url && cached.key === key) return cached.client;
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    // Resolved per call, so a test's stubbed fetch (and the Worker's own) is always the one used.
    global: { fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init) },
  });
  cached = { url, key, client };
  return client;
}

/** A database failure. Mapped to `internal` for the app, and logged; never shown raw. */
export class DbError extends Error {
  readonly op: string;
  readonly pgCode: string | null;
  constructor(op: string, message: string, pgCode: string | null = null) {
    super(`${op}: ${message}`);
    this.name = "DbError";
    this.op = op;
    this.pgCode = pgCode;
  }
}

/** Unwrap a supabase-js result or throw a DbError naming what we were doing. */
export function must<T>(res: { data: T | null; error: { message?: string; code?: string } | null }, op: string): T | null {
  if (res.error) throw new DbError(op, res.error.message ?? "unknown", res.error.code ?? null);
  return res.data;
}

// ── phone_caller_context(p_user_id) ─────────────────────────────────────────────────
// One row, uncached (SPEC section 2). Null when the user is on no team.

export interface CallerContext {
  client_id: string;
  phone_status: string;
  phone_level: Level;
  contacts_level: Level;
  own_contacts_only: boolean;
  device_generation: number;
  number: { id: string; e164: string; voice_enabled: boolean; registration_status: string | null } | null;
  full_name: string | null;
}

export async function callerContext(admin: Admin, userId: string): Promise<CallerContext | null> {
  const data = must(await admin.rpc("phone_caller_context", { p_user_id: userId }), "phone_caller_context") as
    | Partial<CallerContext>
    | null;
  if (!data || typeof data !== "object" || !data.client_id) return null;
  return {
    client_id: String(data.client_id),
    phone_status: String(data.phone_status ?? "off"),
    phone_level: normLevel(data.phone_level),
    contacts_level: normLevel(data.contacts_level),
    own_contacts_only: data.own_contacts_only === true || data.contacts_level === "own",
    device_generation: Number.isInteger(Number(data.device_generation)) && Number(data.device_generation) >= 1
      ? Number(data.device_generation)
      : 1,
    number: data.number && typeof data.number === "object" && data.number.e164
      ? {
        id: String(data.number.id),
        e164: String(data.number.e164),
        voice_enabled: data.number.voice_enabled === true,
        registration_status: data.number.registration_status ?? null,
      }
      : null,
    full_name: data.full_name ?? null,
  };
}

export function normLevel(v: unknown): Level {
  return v === "own" || v === "view" || v === "edit" ? v : "none";
}

// ── phone_route_for_number(p_e164) ──────────────────────────────────────────────────

export interface PhoneRoute {
  id?: string;
  mode: "all_at_once" | "in_order";
  members: string[];
  ring_seconds: number;
  no_answer: "voicemail" | "forward";
  forward_to: string | null;
  business_hours: Record<string, [string, string][]> | null;
  time_zone: string;
  after_hours: "voicemail" | "forward";
  greeting_url: string | null;
}

export interface RouteMember {
  user_id: string;
  identity: string;
  dnd: boolean;
  /** Not in the SPEC shape; honoured if the RPC ever returns it (an expired DND is not DND). */
  dnd_until?: string | null;
  busy: boolean;
  has_access: boolean;
  full_name: string | null;
  forward_to_cell: string | null;
}

export interface RouteInfo {
  client_id: string;
  number_id: string;
  phone_status: string;
  route: PhoneRoute;
  members: RouteMember[];
  business_name: string | null;
  recent_emergency_user: string | null;
}

export const DEFAULT_ROUTE: PhoneRoute = {
  mode: "all_at_once",
  members: [],
  ring_seconds: 20,
  no_answer: "voicemail",
  forward_to: null,
  business_hours: null,
  time_zone: "America/Chicago",
  after_hours: "voicemail",
  greeting_url: null,
};

export async function routeForNumber(admin: Admin, e164: string): Promise<RouteInfo | null> {
  const data = must(await admin.rpc("phone_route_for_number", { p_e164: e164 }), "phone_route_for_number") as
    | (Partial<RouteInfo> & { route?: Partial<PhoneRoute> | null })
    | null;
  if (!data || typeof data !== "object" || !data.client_id || !data.number_id) return null;
  const r = (data.route ?? {}) as Partial<PhoneRoute>;
  const ring = Number(r.ring_seconds);
  return {
    client_id: String(data.client_id),
    number_id: String(data.number_id),
    phone_status: String(data.phone_status ?? "off"),
    route: {
      id: r.id,
      mode: r.mode === "in_order" ? "in_order" : "all_at_once",
      members: Array.isArray(r.members) ? r.members.map(String) : [],
      ring_seconds: Number.isFinite(ring) ? Math.min(60, Math.max(5, Math.round(ring))) : DEFAULT_ROUTE.ring_seconds,
      no_answer: r.no_answer === "forward" ? "forward" : "voicemail",
      forward_to: r.forward_to ? String(r.forward_to) : null,
      business_hours: r.business_hours && typeof r.business_hours === "object" ? r.business_hours : null,
      time_zone: r.time_zone ? String(r.time_zone) : DEFAULT_ROUTE.time_zone,
      after_hours: r.after_hours === "forward" ? "forward" : "voicemail",
      greeting_url: r.greeting_url ? String(r.greeting_url) : null,
    },
    members: Array.isArray(data.members)
      ? data.members.filter((m) => m && m.user_id && m.identity).map((m) => ({
        user_id: String(m.user_id),
        identity: String(m.identity),
        dnd: m.dnd === true,
        dnd_until: m.dnd_until ?? null,
        busy: m.busy === true,
        has_access: m.has_access === true,
        full_name: m.full_name ?? null,
        forward_to_cell: m.forward_to_cell ? String(m.forward_to_cell) : null,
      }))
      : [],
    business_name: data.business_name ?? null,
    recent_emergency_user: data.recent_emergency_user ? String(data.recent_emergency_user) : null,
  };
}

// ── phone_calls ─────────────────────────────────────────────────────────────────────

export interface CallRow {
  id: string;
  client_id: string;
  number_id: string | null;
  contact_id: string | null;
  direction: "in" | "out";
  from_e164: string;
  to_e164: string;
  twilio_call_sid: string | null;
  client_call_sid: string | null;
  placed_by: string | null;
  answered_by: string | null;
  rang_user_ids: string[];
  transferred_from: string | null;
  transfer_state: "transferring" | "conference" | null;
  status: string;
  started_at: string;
  answered_at: string | null;
  ended_at: string | null;
  duration_s: number | null;
  error_code: string | null;
  is_emergency: boolean;
}

export const CALL_COLUMNS =
  "id, client_id, number_id, contact_id, direction, from_e164, to_e164, twilio_call_sid, client_call_sid, placed_by, answered_by, rang_user_ids, transferred_from, transfer_state, status, started_at, answered_at, ended_at, duration_s, error_code, is_emergency";

export async function callById(admin: Admin, id: string): Promise<CallRow | null> {
  return must(
    await admin.from("phone_calls").select(CALL_COLUMNS).eq("id", id).maybeSingle(),
    "read phone_calls",
  ) as CallRow | null;
}

/** Record one timing mark / event. Best-effort by design: a lost mark never fails a call. */
export async function addCallEvent(admin: Admin, callId: string, type: string, data: Record<string, unknown> | null, at?: string): Promise<void> {
  const row: Record<string, unknown> = { call_id: callId, type, data };
  if (at) row.at = at;
  const { error } = await admin.from("phone_call_events").insert(row);
  if (error) console.warn(`[phone-api] phone_call_events insert failed: ${error.message}`);
}

/**
 * Update one phone_calls row, optionally only if `guard` still matches (a conditional write
 * is how two webhooks racing on one call cannot both win). Returns the rows changed; a failure
 * is logged and counts as 0, never thrown, because these run after Twilio has its answer.
 */
export async function patchCall(admin: Admin, id: string, patch: Record<string, unknown>, guard?: (q: any) => any): Promise<number> {
  let q = admin.from("phone_calls").update(patch).eq("id", id);
  if (guard) q = guard(q);
  const { data, error } = await q.select("id");
  if (error) {
    await logFault({ code: "phone_call_update_failed", message: `phone_calls update failed: ${error.message}`, context: { callId: id, fields: Object.keys(patch) } });
    return 0;
  }
  return Array.isArray(data) ? data.length : 0;
}
