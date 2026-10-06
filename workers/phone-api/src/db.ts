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

// ── The business's call recording settings (migration 263) ──────────────────────────
// Both RPCs return them as `recording`, read from client_settings. Whether a call is ARMED
// (announced, so it may be recorded) is the Worker's decision: these plus the CALL_RECORDING
// rail (recording.ts armedFor).

export interface RecordingSettings {
  /** The business turned recording on (client_settings.phone_record_calls). */
  on: boolean;
  /** Play the announcement. Locked on for now: a call is armed only while this is true. */
  notice: boolean;
  /** The business's own sentence, or null for the standard one (recording.ts noticeText). */
  notice_text: string | null;
  /** Transcripts and summaries, while recording is on. */
  transcribe: boolean;
}

/** What a business with no settings (or a database before 263) has: off. */
export const RECORDING_OFF: RecordingSettings = { on: false, notice: true, notice_text: null, transcribe: true };

/** An RPC's `recording` block. Anything missing or malformed reads as off, never as on. */
export function recordingSettingsOf(v: unknown): RecordingSettings {
  if (!v || typeof v !== "object") return { ...RECORDING_OFF };
  const r = v as Record<string, unknown>;
  const text = typeof r.notice_text === "string" ? r.notice_text.trim() : "";
  return {
    on: r.on === true,
    notice: r.notice !== false,
    notice_text: text ? text.slice(0, 300) : null,
    transcribe: r.transcribe !== false,
  };
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
  /**
   * The number this person's calls show (migration 266: their own number first, then a team line,
   * then the texting number, then the oldest). Before 266, the business's one number.
   */
  number: { id: string; e164: string; voice_enabled: boolean; registration_status: string | null } | null;
  /**
   * Every live number of the business, E.164, oldest first (migration 266). A database before 266
   * returns none: then it is `number` alone, which was the business's only number.
   */
  numbers: string[];
  full_name: string | null;
  /** The business's call recording settings (migration 263). */
  recording: RecordingSettings;
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
    numbers: businessNumbersOf((data as { numbers?: unknown }).numbers, data.number?.e164),
    full_name: data.full_name ?? null,
    recording: recordingSettingsOf((data as { recording?: unknown }).recording),
  };
}

/**
 * The RPC's `numbers`, E.164 strings only, at most 50, with `number` always in it: the list a
 * ringing call's From is compared against (a teammate's transfer rings From a business number).
 * Missing or malformed (a database before 266) reads as `number` alone.
 */
export function businessNumbersOf(v: unknown, number?: string | null): string[] {
  const out: string[] = [];
  for (const x of Array.isArray(v) ? v : []) {
    const e = typeof x === "string" ? x.trim() : "";
    if (/^\+[1-9]\d{6,14}$/.test(e) && !out.includes(e)) out.push(e);
    if (out.length >= 50) break;
  }
  const own = typeof number === "string" ? number.trim() : "";
  if (own && !out.includes(own)) out.unshift(own);
  return out;
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
  /**
   * Migration 264: the teammate who rings in this person's place while they're away (on DND),
   * or null for nobody extra. Optional so a database before 264 (and the many fixtures written
   * before it) reads as no cover.
   */
  dnd_cover?: string | null;
  /**
   * Migration 264: this row is only here as someone's cover (they are not on the answer list).
   * It rings only in an away member's place (routes/voice.ts ringSlots), never on its own, and
   * nothing outside the cover logic reads it.
   */
  cover_only?: boolean;
  /**
   * Migration 264: the hours this person's phone rings ({"mon":[["08:00","17:00"]], ...}), or
   * null for always. Outside them they count as away, like DND (routes/voice.ts isAway).
   * Optional so a database before 264 (and the fixtures written before it) reads as always.
   */
  ring_hours?: Record<string, unknown> | null;
  /** Migration 264: the time zone ring_hours are in, or null for the number's (route.time_zone). */
  hours_tz?: string | null;
  /**
   * Migration 264: this person's own voicemail greeting, a Twilio recording sid, or null. Played
   * on a line that is only theirs (../voicemail.ts lineOwner). Optional, like the keys above.
   */
  greeting_sid?: string | null;
}

export interface RouteInfo {
  client_id: string;
  number_id: string;
  phone_status: string;
  route: PhoneRoute;
  members: RouteMember[];
  business_name: string | null;
  recent_emergency_user: string | null;
  /**
   * Migration 266: the person the dialled number belongs to (sms_numbers.assigned_user_id), with
   * their own greeting and whether they have phone access on this business; null for a team line,
   * and from a database before 266. Their greeting plays on the number's voicemail
   * (../voicemail.ts lineOwner). Optional so the fixtures written before it read as a team line.
   */
  number_owner?: { user_id: string; greeting_sid: string | null; has_access: boolean } | null;
  /** The business's call recording settings (migration 263). */
  recording: RecordingSettings;
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
        dnd_cover: m.dnd_cover ? String(m.dnd_cover) : null,
        cover_only: m.cover_only === true,
        ring_hours: m.ring_hours && typeof m.ring_hours === "object" && !Array.isArray(m.ring_hours) ? m.ring_hours : null,
        hours_tz: m.hours_tz ? String(m.hours_tz) : null,
        // Only a real recording sid: the Worker builds a URL from it.
        greeting_sid: typeof m.greeting_sid === "string" && /^RE[0-9a-f]{32}$/.test(m.greeting_sid) ? m.greeting_sid : null,
      }))
      : [],
    business_name: data.business_name ?? null,
    recent_emergency_user: data.recent_emergency_user ? String(data.recent_emergency_user) : null,
    number_owner: numberOwnerOf((data as { number_owner?: unknown }).number_owner),
    recording: recordingSettingsOf(data.recording),
  };
}

/** The RPC's `number_owner` (migration 266). Anything missing or malformed is a team line. */
export function numberOwnerOf(v: unknown): RouteInfo["number_owner"] {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.user_id !== "string" || !o.user_id) return null;
  return {
    user_id: o.user_id,
    // Only a real recording sid: the Worker builds a URL from it.
    greeting_sid: typeof o.greeting_sid === "string" && /^RE[0-9a-f]{32}$/.test(o.greeting_sid) ? o.greeting_sid : null,
    has_access: o.has_access === true,
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
  // Moving the call to the person's other device (migration 260, handoff.ts). Optional so the
  // many fixtures written before it need nothing; the Worker always selects them.
  /** ringing / connecting while a move is under way, else null. */
  handoff_state?: "ringing" | "connecting" | null;
  handoff_to?: "chrome" | "mobile" | null;
  /** The one-time key the answering device must present. A capability: never written to phone_call_events, never broadcast. */
  handoff_key?: string | null;
  /** When it started ringing, then when it was answered. */
  handoff_at?: string | null;
  /** The answering leg (for the phone: the ring the Worker placed). */
  handoff_sid?: string | null;
  /** The leg the call is moving away from. */
  handoff_from_sid?: string | null;
  /**
   * The TwiML this call ran carried the recording announcement, so it may be recorded
   * (migration 263, recording.ts). Optional for the same reason as the handoff columns; absent
   * reads as not armed, and nothing about recording runs for the call.
   */
  recording_armed?: boolean;
}

// ⚠️ recording_armed is migration 263's: this Worker must not be deployed before it is applied.
export const CALL_COLUMNS =
  "id, client_id, number_id, contact_id, direction, from_e164, to_e164, twilio_call_sid, client_call_sid, placed_by, answered_by, rang_user_ids, transferred_from, transfer_state, status, started_at, answered_at, ended_at, duration_s, error_code, is_emergency, "
  + "handoff_state, handoff_to, handoff_key, handoff_at, handoff_sid, handoff_from_sid, recording_armed";

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
