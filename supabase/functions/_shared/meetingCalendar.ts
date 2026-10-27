// meetingCalendar.ts — bookings on the host's own Google / Outlook calendar, busy times from it,
// and Meet / Teams links (migration 341, MEETINGS_SCOPE.md phases 3 and 4).
//
// Carolyn's decisions (2026-10-26):
//   * EVERY booking goes on the host's connected calendar, and moves or leaves with the booking.
//   * The CUSTOMER IS A GUEST on that event: Google / Microsoft send the one calendar invite, and
//     the host sees Accept / Decline there. `meetings.calendar_invited` records that, and our own
//     emails then go without a .ics so nobody gets two invites.
//   * The primary calendar always blocks booking times; ticked extra calendars do too.
//   * A host with nothing connected keeps today's behaviour exactly.
//
// The entry points the booking paths call, in place of meetingVideo's three verbs:
//   onBooked(meetingId)    — Zoom link if the type wants one, then the calendar event (which
//                            makes the Meet / Teams link when the type wants one of those)
//   onMoved(meetingId)     — the same, for a reschedule
//   onCancelled(meetingId) — remove both
// Plus busy times: syncAllBusy (the 5-minute tick, from meeting-reminders), syncConnectionBusy
// (right after connecting) and liveBusyCheck (one look at booking time).
//
// ⚠️ NOTHING HERE MAY FAIL A BOOKING. Every function returns an outcome instead of throwing, and
// every provider call has a timeout. A calendar that cannot be written leaves a booking that
// works exactly as it did before this migration: our email carries the .ics.

import { logEdgeError } from "./logError.ts";
import { bookManageUrl } from "./customerPortalUrl.ts";
import {
  type BusyBlock,
  type CalendarEventInput,
  type FetchLike,
  ProviderError,
} from "./providerHttp.ts";
import { providerAccess, withProvider, type TokenConn } from "./providerTokens.ts";
import {
  googleCreateEvent, googleCredsFromEnv, googleDeleteEvent, googleFreeBusy, googlePatchEvent, googleRefresh,
} from "./googleCalendarApi.ts";
import {
  msBusy, msCancelEvent, msCreateEvent, msCredsFromEnv, msPatchEvent, msRefresh,
} from "./microsoftGraphApi.ts";
import { dropConference, ensureConference, moveConference, type VideoEnv } from "./meetingVideo.ts";

export type CalProvider = "google" | "microsoft";
// deno-lint-ignore no-explicit-any
type Admin = any;

/** How far ahead busy times are kept. Booking windows are capped at 365 days, but nearly all
 *  bookings are within weeks, and a 60-day window keeps each sync one or two API calls. */
export const BUSY_WINDOW_DAYS = 60;
const STALE_CLAIM_MS = 2 * 60_000;

export function calendarReadiness(get: (k: string) => string | undefined) {
  return { google: !!googleCredsFromEnv(get), microsoft: !!msCredsFromEnv(get) };
}

const nowOf = (env: VideoEnv) => (env.now ? env.now() : Date.now());
const fetchOf = (env: VideoEnv): FetchLike => env.fetch ?? fetch;

// ── Provider plumbing ────────────────────────────────────────────────────────────────────

interface CalConn extends TokenConn {
  provider: CalProvider;
  host_id: string;
  client_id: string;
  user_id: string;
  status: string;
  busy_calendar_ids: string[] | null;
  write_calendar_id: string | null;
}

const CONN_COLS = "id, client_id, host_id, user_id, provider, status, access_token, refresh_token, token_expires, busy_calendar_ids, write_calendar_id";

/** The refresher for a connection, or null when that provider's secrets are not set. */
function refresherFor(provider: CalProvider, env: VideoEnv) {
  const f = fetchOf(env), now = nowOf(env);
  if (provider === "google") {
    const c = googleCredsFromEnv(env.get);
    return c ? (rt: string) => googleRefresh(c, rt, f, now) : null;
  }
  const c = msCredsFromEnv(env.get);
  return c ? (rt: string) => msRefresh(c, rt, f, now) : null;
}

async function hostCalendarConns(admin: Admin, hostId: string): Promise<CalConn[]> {
  const { data, error } = await admin.from("meeting_connections").select(CONN_COLS)
    .eq("host_id", hostId).in("provider", ["google", "microsoft"]);
  if (error) throw error;
  return ((data ?? []) as CalConn[]).filter((c) => c.status === "connected");
}

function codeOf(e: unknown): string {
  if (e instanceof ProviderError) return e.code === "invalid_grant" ? "needs_reconnect" : e.code;
  return "provider_error";
}

const LOGGED = new Set(["provider_error", "refused", "rate_limited", "unauthorized", "internal"]);

async function logCal(clientId: string | null, code: string, what: string, e: unknown) {
  if (!LOGGED.has(code)) return;
  await logEdgeError({
    fn: "meeting-calendar",
    clientId,
    code: `calendar_${code}`,
    // Our own words plus the status; never a provider's response body or a token.
    message: `${what}: ${(e as Error)?.message ?? "error"}`,
    severity: code === "rate_limited" ? "warn" : "error",
    context: { status: e instanceof ProviderError ? e.status : null },
  });
}

// ── Busy times ───────────────────────────────────────────────────────────────────────────

async function fetchBlocks(admin: Admin, conn: CalConn, fromIso: string, toIso: string, env: VideoEnv, timeoutMs: number): Promise<BusyBlock[]> {
  const refresh = refresherFor(conn.provider, env);
  if (!refresh) return [];
  const ids = ["primary", ...(conn.busy_calendar_ids ?? []).filter((x) => x && x !== "primary")];
  const f = fetchOf(env);
  return await withProvider(admin, conn, refresh, nowOf(env), (t) => conn.provider === "google"
    ? googleFreeBusy(t, ids, fromIso, toIso, f, timeoutMs)
    : msBusy(t, ids, fromIso, toIso, f, timeoutMs));
}

/** Our own bookings already block their time. A busy block that IS one of them must not also
 *  count, or a booking would block its own reschedule. Matched on the event id where the
 *  provider gives one (Microsoft) and on the exact start/end otherwise (Google's freeBusy). */
async function ownBookingFilter(admin: Admin, hostId: string, fromIso: string, toIso: string, exceptMeetingId?: string | null) {
  const { data } = await admin.from("meetings").select("id, starts_at, ends_at, external_event_id")
    .eq("host_id", hostId).eq("status", "booked").lt("starts_at", toIso).gt("ends_at", fromIso);
  // deno-lint-ignore no-explicit-any
  const rows = (data ?? []) as any[];
  const times = new Set(rows.map((m) => `${Date.parse(m.starts_at)}|${Date.parse(m.ends_at)}`));
  const keys = new Set(rows.filter((m) => m.external_event_id).map((m) => `m:${m.external_event_id}`));
  // A reschedule asks "is the NEW time free?": the meeting being moved is not in the way of itself.
  if (exceptMeetingId) {
    const self = rows.find((m) => m.id === exceptMeetingId);
    if (self) { times.add(`${Date.parse(self.starts_at)}|${Date.parse(self.ends_at)}`); }
  }
  return (b: BusyBlock) => !keys.has(b.key) && !times.has(`${Date.parse(b.startsAt)}|${Date.parse(b.endsAt)}`);
}

/**
 * Refresh one connection's busy blocks in meeting_busy. Upsert this run's rows, then delete the
 * ones this run did not see, so availability is never briefly empty mid-sync.
 */
export async function syncConnectionBusy(admin: Admin, conn: CalConn, env: VideoEnv): Promise<{ ok: boolean; blocks?: number; reason?: string }> {
  const now = nowOf(env);
  const runAt = new Date(now).toISOString();
  const fromIso = new Date(now - 60 * 60_000).toISOString();
  const toIso = new Date(now + BUSY_WINDOW_DAYS * 86_400_000).toISOString();
  try {
    if (!refresherFor(conn.provider, env)) return { ok: false, reason: "not_set_up" };
    const keep = await ownBookingFilter(admin, conn.host_id, fromIso, toIso);
    const blocks = (await fetchBlocks(admin, conn, fromIso, toIso, env, 15_000)).filter(keep);
    const seen = new Set<string>();
    const rows = [];
    for (const b of blocks) {
      if (seen.has(b.key)) continue;
      seen.add(b.key);
      rows.push({
        client_id: conn.client_id, host_id: conn.host_id, user_id: conn.user_id, provider: conn.provider,
        external_id: b.key, starts_at: b.startsAt, ends_at: b.endsAt, synced_at: runAt,
      });
    }
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await admin.from("meeting_busy").upsert(rows.slice(i, i + 500), { onConflict: "host_id,provider,external_id" });
      if (error) throw error;
    }
    const { error: de } = await admin.from("meeting_busy").delete()
      .eq("host_id", conn.host_id).eq("provider", conn.provider).lt("synced_at", runAt);
    if (de) throw de;
    await admin.from("meeting_connections").update({ last_synced_at: runAt, last_error: null }).eq("id", conn.id);
    return { ok: true, blocks: rows.length };
  } catch (e) {
    const code = codeOf(e);
    await admin.from("meeting_connections").update({ last_error: code }).eq("id", conn.id);
    await logCal(conn.client_id, code, "Could not read busy times", e);
    return { ok: false, reason: code };
  }
}

/** The 5-minute tick: the connections least recently synced first, inside a time budget. */
export async function syncAllBusy(admin: Admin, env: VideoEnv, opts: { limit?: number; budgetMs?: number } = {}) {
  const started = nowOf(env);
  const out = { synced: 0, failed: 0, skipped: 0 };
  const { data, error } = await admin.from("meeting_connections").select(CONN_COLS)
    .in("provider", ["google", "microsoft"]).eq("status", "connected")
    .order("last_synced_at", { ascending: true, nullsFirst: true }).limit(opts.limit ?? 40);
  if (error) { await logCal(null, "internal", "Could not list calendar connections to sync", error); return out; }
  for (const conn of (data ?? []) as CalConn[]) {
    if (Date.now() - started > (opts.budgetMs ?? 25_000)) { out.skipped++; continue; }
    const r = await syncConnectionBusy(admin, conn, env);
    if (r.ok) out.synced++; else out.failed++;
  }
  return out;
}

/**
 * One look at the host's own calendars at booking time, closing the gap between syncs. FAILS
 * OPEN: a slow or broken provider answers "free", and the 5-minute sync remains the backstop —
 * a booking is never refused because Google was slow.
 */
export async function liveBusyCheck(
  admin: Admin, hostId: string, fromIso: string, toIso: string, env: VideoEnv, exceptMeetingId?: string | null,
): Promise<boolean> {
  try {
    const conns = await hostCalendarConns(admin, hostId);
    if (!conns.length) return false;
    const keep = await ownBookingFilter(admin, hostId, fromIso, toIso, exceptMeetingId);
    const from = Date.parse(fromIso), to = Date.parse(toIso);
    for (const conn of conns) {
      const blocks = (await fetchBlocks(admin, conn, fromIso, toIso, env, 4_000).catch(() => [])).filter(keep);
      if (blocks.some((b) => Date.parse(b.startsAt) < to && Date.parse(b.endsAt) > from)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ── The event on the host's calendar ─────────────────────────────────────────────────────

const MEETING_COLS =
  "id, client_id, host_id, status, starts_at, ends_at, customer_name, customer_email, customer_notes, cancel_token, " +
  "conference_provider, conference_url, conference_note, conference_external_id, conference_status, " +
  "external_event_id, external_provider, external_calendar_id, calendar_invited, calendar_status, calendar_attempted_at, " +
  "meeting_types!inner(name, location_kind, location_detail, conference_mode, conference_provider), " +
  "meeting_hosts!inner(public_name, time_zone, calendar_provider)";

/** Which calendar this booking goes on, and whether that event makes the video link. */
function pickTarget(
  // deno-lint-ignore no-explicit-any
  m: any, conns: CalConn[],
): { conn: CalConn | null; withVideo: boolean; videoWanted: CalProvider | null } {
  const t = m.meeting_types || {};
  const videoWanted: CalProvider | null = t.conference_mode === "generate"
    ? (t.conference_provider === "google_meet" ? "google" : t.conference_provider === "teams" ? "microsoft" : null)
    : null;
  const by = (p: CalProvider | null) => (p ? conns.find((c) => c.provider === p) ?? null : null);
  if (videoWanted && by(videoWanted)) return { conn: by(videoWanted), withVideo: true, videoWanted };
  const preferred = by(m.meeting_hosts?.calendar_provider ?? null);
  return { conn: preferred ?? conns[0] ?? null, withVideo: false, videoWanted };
}

async function businessName(admin: Admin, clientId: string): Promise<string> {
  const [{ data: s }, { data: c }] = await Promise.all([
    admin.from("client_settings").select("business_name").eq("client_id", clientId).maybeSingle(),
    admin.from("client_configs").select("company_name").eq("client_id", clientId).maybeSingle(),
  ]);
  return (s?.business_name || c?.company_name || "").trim();
}

// deno-lint-ignore no-explicit-any
function eventFor(m: any, biz: string, joinUrl: string | null): Omit<CalendarEventInput, "withVideo" | "requestId"> {
  const t = m.meeting_types || {};
  const host = m.meeting_hosts?.public_name || biz || "us";
  const link = joinUrl ?? m.conference_url ?? null;
  const lines = [
    `${t.name || "Meeting"} with ${host}${biz && biz !== host ? ` (${biz})` : ""}.`,
    link ? `Join: ${link}` : "",
    link && m.conference_note ? `To get in: ${m.conference_note}` : "",
    !link && t.location_detail ? `Where: ${t.location_detail}` : "",
    m.customer_notes ? `Notes from ${m.customer_name}: ${m.customer_notes}` : "",
    m.cancel_token ? `Need to change it? ${bookManageUrl(m.cancel_token, null)}` : "",
  ].filter(Boolean);
  return {
    title: `${t.name || "Meeting"}: ${m.customer_name} & ${host}`,
    description: lines.join("\n\n"),
    location: link || t.location_detail || null,
    startsAt: m.starts_at,
    endsAt: m.ends_at,
    timeZone: m.meeting_hosts?.time_zone || "UTC",
    attendee: m.customer_email ? { email: String(m.customer_email), name: String(m.customer_name || "") } : null,
  };
}

export type CalendarOutcome =
  | { status: "created"; video: "made" | "none" | "missing" }
  | { status: "skipped"; reason: string }
  | { status: "pending" }
  | { status: "failed"; reason: string }
  | { status: "moved" | "kept" | "dropped" };

/**
 * Put a booked meeting on the host's calendar, inviting the customer, and make its Meet / Teams
 * link when the type wants one. Idempotent, and only one request can hold the claim.
 */
export async function ensureCalendarEvent(admin: Admin, meetingId: string, env: VideoEnv): Promise<CalendarOutcome> {
  const now = nowOf(env);
  // deno-lint-ignore no-explicit-any
  let m: any = null;
  let conns: CalConn[] = [];
  try {
    const { data, error } = await admin.from("meetings").select(MEETING_COLS).eq("id", meetingId).maybeSingle();
    if (error) throw error;
    m = data;
    if (!m) return { status: "skipped", reason: "no_meeting" };
    if (m.status !== "booked") return { status: "skipped", reason: "not_booked" };
    if (m.external_event_id) return { status: "created", video: "none" };
    conns = (await hostCalendarConns(admin, m.host_id)).filter((c) => !!refresherFor(c.provider, env));
  } catch (e) {
    await logCal(m?.client_id ?? null, "internal", "Could not read the meeting for its calendar event", e);
    return { status: "skipped", reason: "internal" };
  }

  const { conn, withVideo, videoWanted } = pickTarget(m, conns);

  // A Meet / Teams type whose host has not connected that provider: the link falls back exactly
  // like an unconnected Zoom (room link kept, or "a link will follow").
  const conferenceFallback = async (code: string) => {
    if (!videoWanted || m.conference_external_id) return;
    await admin.from("meetings").update({
      conference_status: m.conference_url ? "fallback" : "failed", conference_error: code,
    }).eq("id", meetingId).is("conference_external_id", null);
  };

  if (!conn) {
    await conferenceFallback("not_connected");
    await admin.from("meetings").update({ calendar_status: "skipped", calendar_error: null }).eq("id", meetingId).is("external_event_id", null);
    return { status: "skipped", reason: "not_connected" };
  }
  if (videoWanted && !withVideo) await conferenceFallback("not_connected");

  // ── The claim ──
  const stale = new Date(now - STALE_CLAIM_MS).toISOString();
  const { data: claimed, error: ce } = await admin.from("meetings").update({
    calendar_status: "pending", calendar_attempted_at: new Date(now).toISOString(),
  }).eq("id", meetingId).eq("status", "booked").is("external_event_id", null)
    .or(`calendar_status.is.null,calendar_status.in.(failed,skipped),calendar_attempted_at.lt.${stale}`)
    .select("id").maybeSingle();
  if (ce) { await logCal(m.client_id, "internal", "Could not claim the meeting for its calendar event", ce); return { status: "skipped", reason: "internal" }; }
  if (!claimed) return { status: "pending" };

  const refresh = refresherFor(conn.provider, env)!;
  const f = fetchOf(env);
  const calendarId = conn.write_calendar_id || "primary";
  try {
    const biz = await businessName(admin, m.client_id);
    const ev: CalendarEventInput = { ...eventFor(m, biz, null), withVideo, requestId: `ss-${meetingId}` };
    const made = await withProvider(admin, conn, refresh, now, (t) => conn.provider === "google"
      ? googleCreateEvent(t, calendarId, ev, f)
      : msCreateEvent(t, calendarId, ev, f));

    const patch: Record<string, unknown> = {
      external_event_id: made.id,
      external_provider: conn.provider,
      external_calendar_id: calendarId,
      calendar_invited: !!ev.attendee,
      calendar_status: "created",
      calendar_error: null,
    };
    let video: "made" | "none" | "missing" = "none";
    if (withVideo) {
      if (made.joinUrl) {
        video = "made";
        Object.assign(patch, {
          conference_provider: conn.provider === "google" ? "google_meet" : "teams",
          conference_url: made.joinUrl,
          conference_note: null,
          conference_external_id: made.id,
          conference_status: "generated",
          conference_error: null,
        });
      } else {
        // The event exists but the provider made no link — a personal Outlook.com account has
        // no Teams. The booking keeps its room link, or says a link will follow.
        video = "missing";
        Object.assign(patch, { conference_status: m.conference_url ? "fallback" : "failed", conference_error: "no_link" });
      }
    }
    const { data: landed, error: ue } = await admin.from("meetings").update(patch)
      .eq("id", meetingId).eq("status", "booked").select("id").maybeSingle();
    if (ue || !landed) {
      // Cancelled while we were at the provider: take the event back off their calendar.
      await withProvider(admin, conn, refresh, now, (t) => conn.provider === "google"
        ? googleDeleteEvent(t, calendarId, made.id, !!ev.attendee, f)
        : msCancelEvent(t, made.id, !!ev.attendee, f)).catch(() => {});
      if (ue) throw ue;
      return { status: "skipped", reason: "not_booked" };
    }
    return { status: "created", video };
  } catch (e) {
    const code = codeOf(e);
    await admin.from("meetings").update({ calendar_status: "failed", calendar_error: code })
      .eq("id", meetingId).eq("calendar_status", "pending");
    if (withVideo) await conferenceFallback(code);
    await logCal(m.client_id, code, "Could not put the booking on the host's calendar", e);
    return { status: "failed", reason: code };
  }
}

/** Load the connection that holds this meeting's event (the provider it was made with). */
// deno-lint-ignore no-explicit-any
async function eventConn(admin: Admin, m: any, env: VideoEnv): Promise<CalConn | null> {
  if (!m.external_event_id || !m.external_provider) return null;
  const conns = await hostCalendarConns(admin, m.host_id);
  const c = conns.find((x) => x.provider === m.external_provider) ?? null;
  return c && refresherFor(c.provider, env) ? c : null;
}

/** The booking moved: move the event (the provider tells the customer). No event yet = try now. */
export async function moveCalendarEvent(admin: Admin, meetingId: string, env: VideoEnv): Promise<CalendarOutcome> {
  // deno-lint-ignore no-explicit-any
  let m: any = null;
  try {
    const { data, error } = await admin.from("meetings").select(MEETING_COLS).eq("id", meetingId).maybeSingle();
    if (error) throw error;
    m = data;
    if (!m || m.status !== "booked") return { status: "skipped", reason: "not_booked" };
    if (!m.external_event_id) return await ensureCalendarEvent(admin, meetingId, env);
    const conn = await eventConn(admin, m, env);
    if (!conn) return { status: "kept" };
    const biz = await businessName(admin, m.client_id);
    const ev = eventFor(m, biz, null);
    const f = fetchOf(env), now = nowOf(env);
    await withProvider(admin, conn, refresherFor(conn.provider, env)!, now, (t) => conn.provider === "google"
      ? googlePatchEvent(t, m.external_calendar_id || "primary", m.external_event_id, ev, !!m.calendar_invited, f)
      : msPatchEvent(t, m.external_event_id, ev, f));
    return { status: "moved" };
  } catch (e) {
    if (e instanceof ProviderError && e.code === "not_found" && m) {
      // Deleted from their calendar by hand: put a fresh one there rather than lose it.
      const wasVideo = m.conference_external_id && m.conference_external_id === m.external_event_id;
      await admin.from("meetings").update({
        external_event_id: null, external_provider: null, external_calendar_id: null,
        calendar_invited: false, calendar_status: "failed", calendar_error: "not_found",
        ...(wasVideo ? { conference_external_id: null, conference_url: null, conference_status: "failed", conference_error: "not_found" } : {}),
      }).eq("id", meetingId);
      return await ensureCalendarEvent(admin, meetingId, env);
    }
    await logCal(m?.client_id ?? null, codeOf(e), "Could not move the booking on the host's calendar", e);
    return { status: "kept" };
  }
}

/** The booking was cancelled: take the event off their calendar (the provider tells the customer). */
export async function dropCalendarEvent(admin: Admin, meetingId: string, env: VideoEnv): Promise<CalendarOutcome> {
  try {
    const { data: m, error } = await admin.from("meetings")
      .select("id, client_id, host_id, external_event_id, external_provider, external_calendar_id, calendar_invited")
      .eq("id", meetingId).maybeSingle();
    if (error) throw error;
    if (!m || !m.external_event_id) return { status: "skipped", reason: "nothing_to_drop" };
    const conn = await eventConn(admin, m, env);
    if (!conn) return { status: "kept" };
    const f = fetchOf(env);
    try {
      await withProvider(admin, conn, refresherFor(conn.provider, env)!, nowOf(env), (t) => conn.provider === "google"
        ? googleDeleteEvent(t, m.external_calendar_id || "primary", m.external_event_id, !!m.calendar_invited, f)
        : msCancelEvent(t, m.external_event_id, !!m.calendar_invited, f));
    } catch (e) {
      await logCal(m.client_id, codeOf(e), "Could not take the cancelled booking off the host's calendar", e);
      return { status: "kept" };
    }
    return { status: "dropped" };
  } catch (e) {
    await logCal(null, "internal", "Could not read the meeting to remove its calendar event", e);
    return { status: "kept" };
  }
}

// ── What the booking paths call ──────────────────────────────────────────────────────────

/** After book_meeting() commits, before the confirmation: Zoom first (its link goes in the event). */
export async function onBooked(admin: Admin, meetingId: string, env: VideoEnv) {
  const video = await ensureConference(admin, meetingId, env);
  const calendar = await ensureCalendarEvent(admin, meetingId, env);
  return { video, calendar };
}

export async function onMoved(admin: Admin, meetingId: string, env: VideoEnv) {
  const video = await moveConference(admin, meetingId, env);
  const calendar = await moveCalendarEvent(admin, meetingId, env);
  return { video, calendar };
}

export async function onCancelled(admin: Admin, meetingId: string, env: VideoEnv) {
  const video = await dropConference(admin, meetingId, env);
  const calendar = await dropCalendarEvent(admin, meetingId, env);
  return { video, calendar };
}

/** Re-exported so callers that only need a token (list_calendars) share one refresh path. */
export async function calendarToken(admin: Admin, conn: CalConn, env: VideoEnv): Promise<string> {
  const refresh = refresherFor(conn.provider, env);
  if (!refresh) throw new ProviderError("refused", 0, "That calendar is not switched on yet.");
  return await providerAccess(admin, conn, refresh, nowOf(env));
}
export type { CalConn };
