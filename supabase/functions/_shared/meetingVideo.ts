// meetingVideo.ts — a fresh video link per booking (migration 333, MEETINGS_SCOPE.md route B).
//
// Three verbs, called by every path that books, moves or cancels a meeting (book-public and
// portal-meetings), always AFTER the meeting row is committed and BEFORE the email about it
// goes out, so the confirmation carries the link:
//
//   ensureConference(meetingId) — booking: create the meeting in the HOST's connected account
//                                  and put its join link on the booking.
//   moveConference(meetingId)   — reschedule: move it there too.
//   dropConference(meetingId)   — cancel: delete it there, so no dead room is left behind.
//
// ⚠️ NONE OF THESE MAY FAIL A BOOKING (Carolyn 2026-10-23: "book anyway, use the room link").
// Each returns an outcome instead of throwing. When a link cannot be made, the type's standing
// room link — which book_meeting() already copied onto the row (329) — stays, and the row says
// 'fallback'; with no room link it says 'failed', the customer's email says a link will follow,
// and the portal offers "Make the link". Every provider call has a timeout, so a hung Zoom
// costs a customer a few seconds on the booking page, never the booking.
//
// Only Zoom is wired today. Google Meet and Teams will come from the Google / Microsoft
// calendar connections; they report 'not_available' until then and the type editor does not
// offer them for generation.

import { logEdgeError } from "./logError.ts";
import {
  type FetchLike,
  type ZoomCreds,
  ZoomError,
  zoomCreateMeeting,
  zoomCredsFromEnv,
  zoomDeleteMeeting,
  zoomRefresh,
  zoomUpdateMeeting,
} from "./zoomApi.ts";

export interface VideoEnv {
  get: (key: string) => string | undefined;
  fetch?: FetchLike;
  now?: () => number;
}

export const denoVideoEnv = (): VideoEnv => ({ get: (k) => Deno.env.get(k) });

export type ConferenceOutcome =
  | { status: "skipped"; reason: string }
  | { status: "pending"; reason: "in_progress" }
  | { status: "generated" }
  | { status: "fallback" | "failed"; reason: string }
  | { status: "moved" | "kept" | "dropped" };

/** Which providers can generate a link right now. Drives what the Settings page offers. */
export function videoReadiness(get: (k: string) => string | undefined) {
  return { zoom: !!zoomCredsFromEnv(get), google_meet: false, teams: false };
}

/** A pending claim older than this belongs to a request that died; it may be taken again. */
const STALE_CLAIM_MS = 2 * 60_000;

// deno-lint-ignore no-explicit-any
type Admin = any;

// ── Access tokens ────────────────────────────────────────────────────────────────────────

/**
 * A usable access token for one connection row, refreshing (and storing the rotated refresh
 * token) when needed. `force` refreshes even a token that has not expired yet, for the case
 * where Zoom has just refused it.
 *
 * ⚠️ The refresh race: Zoom rotates the refresh token, so of two requests refreshing at once
 * one gets `invalid_grant` on a healthy connection. Before calling the connection dead, re-read
 * the row: if somebody else rotated it in the meantime, use what they stored.
 */
// deno-lint-ignore no-explicit-any
async function zoomAccess(admin: Admin, conn: any, creds: ZoomCreds, env: VideoEnv, force = false): Promise<string> {
  const now = env.now ? env.now() : Date.now();
  const f = env.fetch ?? fetch;
  if (!force && conn.access_token && conn.token_expires && Date.parse(conn.token_expires) > now + 60_000) {
    return conn.access_token;
  }
  if (!conn.refresh_token) throw new ZoomError("invalid_grant", 0, "No refresh token on the connection.");
  try {
    const t = await zoomRefresh(creds, conn.refresh_token, f, now);
    const { error } = await admin.from("meeting_connections").update({
      access_token: t.accessToken,
      refresh_token: t.refreshToken,
      token_expires: t.expiresAt,
      status: "connected",
      last_error: null,
      updated_at: new Date(now).toISOString(),
    }).eq("id", conn.id);
    if (error) throw error;
    return t.accessToken;
  } catch (e) {
    if (!(e instanceof ZoomError) || e.code !== "invalid_grant") throw e;
    const { data: fresh } = await admin.from("meeting_connections")
      .select("id, access_token, refresh_token, token_expires, status").eq("id", conn.id).maybeSingle();
    if (fresh && fresh.refresh_token && fresh.refresh_token !== conn.refresh_token &&
        fresh.access_token && fresh.token_expires && Date.parse(fresh.token_expires) > now + 60_000) {
      return fresh.access_token;
    }
    // Really gone: the person revoked us at Zoom, or 90 days passed unused. Say so on their
    // Settings page rather than failing every booking silently.
    await admin.from("meeting_connections").update({
      status: "needs_reauth",
      access_token: null,
      last_error: "needs_reconnect",
      updated_at: new Date(now).toISOString(),
    }).eq("id", conn.id);
    throw e;
  }
}

/** Run one API call with the connection's token; on a 401, refresh once and try again. */
// deno-lint-ignore no-explicit-any
async function withZoom<T>(admin: Admin, conn: any, creds: ZoomCreds, env: VideoEnv, fn: (token: string) => Promise<T>): Promise<T> {
  const token = await zoomAccess(admin, conn, creds, env);
  try {
    return await fn(token);
  } catch (e) {
    if (!(e instanceof ZoomError) || e.code !== "unauthorized") throw e;
    const again = await zoomAccess(admin, conn, creds, env, true);
    return await fn(again);
  }
}

async function zoomConnection(admin: Admin, hostId: string) {
  const { data, error } = await admin.from("meeting_connections")
    .select("id, status, access_token, refresh_token, token_expires")
    .eq("host_id", hostId).eq("provider", "zoom").maybeSingle();
  if (error) throw error;
  return data;
}

function codeOf(e: unknown): string {
  if (e instanceof ZoomError) return e.code === "invalid_grant" ? "needs_reconnect" : e.code;
  return "provider_error";
}

/** Faults worth a person's attention. A host who never connected is a choice, not a fault. */
const LOGGED = new Set(["provider_error", "refused", "rate_limited", "unauthorized", "internal"]);

async function logVideo(clientId: string | null, code: string, what: string, e: unknown) {
  if (!LOGGED.has(code)) return;
  await logEdgeError({
    fn: "meeting-video",
    clientId,
    code: `video_${code}`,
    // Our own words plus the status; never Zoom's response body or a token.
    message: `${what}: ${(e as Error)?.message ?? "error"}`,
    severity: code === "rate_limited" ? "warn" : "error",
    context: { status: e instanceof ZoomError ? e.status : null },
  });
}

const MEETING_COLS =
  "id, client_id, host_id, status, starts_at, ends_at, conference_provider, conference_url, " +
  "conference_external_id, conference_status, conference_attempted_at, " +
  "meeting_types!inner(name, conference_mode, conference_provider), meeting_hosts!inner(time_zone)";

async function topicFor(admin: Admin, clientId: string, typeName: string): Promise<string> {
  // The business's name, not the customer's: the topic is shown in Zoom to everyone who
  // joins, and the customer's details have no reason to be in Zoom at all.
  const [{ data: s }, { data: c }] = await Promise.all([
    admin.from("client_settings").select("business_name").eq("client_id", clientId).maybeSingle(),
    admin.from("client_configs").select("company_name").eq("client_id", clientId).maybeSingle(),
  ]);
  const biz = (s?.business_name || c?.company_name || "").trim();
  return biz ? `${typeName} with ${biz}` : typeName;
}

// ── Booking ──────────────────────────────────────────────────────────────────────────────

/**
 * Give a booked meeting its own video link, when its type asks for one. Idempotent: a meeting
 * that already has one is left alone, and two requests at once cannot both create a Zoom
 * meeting (the 'pending' claim is an UPDATE that only one of them can win).
 */
export async function ensureConference(admin: Admin, meetingId: string, env: VideoEnv): Promise<ConferenceOutcome> {
  const now = env.now ? env.now() : Date.now();
  let clientId: string | null = null;
  // deno-lint-ignore no-explicit-any
  let m: any = null;
  try {
    const { data, error } = await admin.from("meetings").select(MEETING_COLS).eq("id", meetingId).maybeSingle();
    if (error) throw error;
    m = data;
    if (!m) return { status: "skipped", reason: "no_meeting" };
    clientId = m.client_id;
    if (m.status !== "booked") return { status: "skipped", reason: "not_booked" };
    if (m.meeting_types?.conference_mode !== "generate") return { status: "skipped", reason: "room_link" };
    if (m.conference_external_id) return { status: "generated" };

    // ── The claim ──
    const stale = new Date(now - STALE_CLAIM_MS).toISOString();
    const { data: claimed, error: ce } = await admin.from("meetings").update({
      conference_status: "pending",
      conference_attempted_at: new Date(now).toISOString(),
    })
      .eq("id", meetingId).eq("status", "booked").is("conference_external_id", null)
      .or(`conference_status.is.null,conference_status.in.(fallback,failed),conference_attempted_at.lt.${stale}`)
      .select("id").maybeSingle();
    if (ce) throw ce;
    if (!claimed) return { status: "pending", reason: "in_progress" };
  } catch (e) {
    await logVideo(clientId, "internal", "Could not read or claim the meeting for a video link", e);
    return { status: "skipped", reason: "internal" };
  }

  const fail = async (code: string, e?: unknown): Promise<ConferenceOutcome> => {
    // The room link book_meeting() copied is still on the row; keep it as the fallback.
    const status = m.conference_url ? "fallback" : "failed";
    await admin.from("meetings").update({ conference_status: status, conference_error: code })
      .eq("id", meetingId).eq("conference_status", "pending");
    if (e) await logVideo(clientId, code, "Could not create the video meeting", e);
    return { status, reason: code };
  };

  const provider = m.meeting_types?.conference_provider;
  if (provider !== "zoom") return await fail("not_available");
  const creds = zoomCredsFromEnv(env.get);
  if (!creds) return await fail("not_set_up");

  try {
    const conn = await zoomConnection(admin, m.host_id);
    if (!conn) return await fail("not_connected");
    if (conn.status !== "connected") return await fail("needs_reconnect");

    const topic = await topicFor(admin, m.client_id, m.meeting_types?.name || "Meeting");
    const input = {
      topic,
      startsAt: m.starts_at,
      durationMinutes: (Date.parse(m.ends_at) - Date.parse(m.starts_at)) / 60_000,
      timeZone: m.meeting_hosts?.time_zone || "UTC",
    };
    const f = env.fetch ?? fetch;
    const made = await withZoom(admin, conn, creds, env, (t) => zoomCreateMeeting(t, input, f));

    const { data: landed, error: ue } = await admin.from("meetings").update({
      conference_provider: "zoom",
      conference_url: made.joinUrl,
      // The join link already carries the passcode; it is written out for anyone dialling in.
      conference_note: made.password ? `Passcode: ${made.password}` : null,
      conference_external_id: made.id,
      conference_status: "generated",
      conference_error: null,
    }).eq("id", meetingId).eq("status", "booked").select("id").maybeSingle();
    if (ue || !landed) {
      // Cancelled while we were at Zoom (or the write failed): do not leave a room behind.
      await withZoom(admin, conn, creds, env, (t) => zoomDeleteMeeting(t, made.id, f)).catch(() => {});
      if (ue) return await fail("internal", ue);
      return { status: "skipped", reason: "not_booked" };
    }
    return { status: "generated" };
  } catch (e) {
    return await fail(codeOf(e), e);
  }
}

// ── Reschedule ───────────────────────────────────────────────────────────────────────────

/**
 * The booking moved: move its provider meeting. A meeting that never got a link gets another
 * chance at one here, since the person may have connected Zoom since.
 */
export async function moveConference(admin: Admin, meetingId: string, env: VideoEnv): Promise<ConferenceOutcome> {
  // deno-lint-ignore no-explicit-any
  let m: any = null;
  try {
    const { data, error } = await admin.from("meetings").select(MEETING_COLS).eq("id", meetingId).maybeSingle();
    if (error) throw error;
    m = data;
  } catch (e) {
    await logVideo(null, "internal", "Could not read the meeting to move its video link", e);
    return { status: "kept" };
  }
  if (!m || m.status !== "booked") return { status: "skipped", reason: "not_booked" };
  if (!m.conference_external_id) {
    return m.conference_status ? await ensureConference(admin, meetingId, env) : { status: "skipped", reason: "room_link" };
  }
  if (m.conference_provider !== "zoom") return { status: "kept" };
  const creds = zoomCredsFromEnv(env.get);
  if (!creds) return { status: "kept" };
  try {
    const conn = await zoomConnection(admin, m.host_id);
    if (!conn || conn.status !== "connected") return { status: "kept" };
    const f = env.fetch ?? fetch;
    const topic = await topicFor(admin, m.client_id, m.meeting_types?.name || "Meeting");
    await withZoom(admin, conn, creds, env, (t) => zoomUpdateMeeting(t, m.conference_external_id, {
      topic,
      startsAt: m.starts_at,
      durationMinutes: (Date.parse(m.ends_at) - Date.parse(m.starts_at)) / 60_000,
      timeZone: m.meeting_hosts?.time_zone || "UTC",
    }, f));
    return { status: "moved" };
  } catch (e) {
    if (e instanceof ZoomError && e.code === "not_found") {
      // Deleted in Zoom by hand. Make a new one rather than send a link that goes nowhere.
      await admin.from("meetings").update({
        conference_external_id: null, conference_url: null, conference_note: null,
        conference_status: "failed", conference_error: "not_found",
      }).eq("id", meetingId);
      return await ensureConference(admin, meetingId, env);
    }
    // The link still works at the old time's room; only Zoom's own calendar entry is stale.
    await logVideo(m.client_id, codeOf(e), "Could not move the video meeting", e);
    return { status: "kept" };
  }
}

// ── Cancel ───────────────────────────────────────────────────────────────────────────────

/** The booking was cancelled: delete the meeting we created. A standing room is not ours. */
export async function dropConference(admin: Admin, meetingId: string, env: VideoEnv): Promise<ConferenceOutcome> {
  try {
    const { data: m, error } = await admin.from("meetings")
      .select("id, client_id, host_id, conference_provider, conference_external_id").eq("id", meetingId).maybeSingle();
    if (error) throw error;
    if (!m || !m.conference_external_id || m.conference_provider !== "zoom") return { status: "skipped", reason: "nothing_to_drop" };
    const creds = zoomCredsFromEnv(env.get);
    const conn = await zoomConnection(admin, m.host_id);
    if (!creds || !conn || conn.status !== "connected") return { status: "kept" };
    const f = env.fetch ?? fetch;
    try {
      await withZoom(admin, conn, creds, env, (t) => zoomDeleteMeeting(t, m.conference_external_id, f));
    } catch (e) {
      await logVideo(m.client_id, codeOf(e), "Could not delete the cancelled video meeting", e);
      return { status: "kept" };
    }
    return { status: "dropped" };
  } catch (e) {
    await logVideo(null, "internal", "Could not read the meeting to delete its video link", e);
    return { status: "kept" };
  }
}
