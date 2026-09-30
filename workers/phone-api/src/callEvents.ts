// What phone_call_events say about a live call that its row cannot: how the latest warm
// transfer stands (GET /calls `warm`), whether a Resume is still on its way in (Hold), and
// whether the call's conference is recorded as started (conference.ts hasStarted).
// Migration 254 has no column for any of them, and one would be migration 255; the Worker
// already writes the events these are read from, and phone_call_events_call_idx (call_id, at)
// serves every read.
//
// ONLY THE WORKER'S OWN EVENTS COUNT. The apps post timing marks into the same table through
// POST /calls/:id/events, and both post one called `warm_transfer`. That handler always stamps
// `source: "app"` last, so it cannot be spoofed away, and those rows are skipped here.
//
// ONLY THE CALL'S CURRENT CONFERENCE COUNTS. A call's conference is named after the call, so a
// call can be in two of them one after the other: a cold transfer (the Worker's `transfer`
// event) redirects the customer out, which ends the first, and the teammate who takes it can
// press Hold or Warm transfer and move it into a second. That is the only way out of one and
// into another, so what happened before the latest `transfer` belongs to a conference that is
// over and is never read as this one's.

import { must, type Admin, type CallRow } from "./db";

export type WarmState = "ringing" | "missed" | "answered";

/** GET /calls `warm`: the latest warm transfer on a live call in its conference. */
export interface WarmInfo {
  /** The teammate it rang. */
  to_user_id: string | null;
  /** ringing: no answer yet; missed: no answer, a decline or busy; answered: they have the call. */
  state: WarmState;
  /** When it was pressed (the Worker's warm_transfer event). */
  at: string;
}

export interface EventRow {
  call_id: string;
  type: string;
  at: string;
  data: Record<string, unknown> | null;
}

/** The cold transfer event: the call's conference, if it had one, ended there. */
const CONFERENCE_ENDED = "transfer";
const WARM_TYPES = ["warm_transfer", "warm_transfer_missed", CONFERENCE_ENDED];

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const fromWorker = (e: EventRow): boolean => e.data?.source !== "app";
/** Oldest first. Date.parse drops microseconds, so the text breaks a tie (same zone, UTC). */
const byTime = (a: EventRow, b: EventRow): number =>
  (Date.parse(a.at) - Date.parse(b.at)) || (a.at < b.at ? -1 : a.at > b.at ? 1 : 0);

/** The Worker's own events since the latest cold transfer, oldest first. */
function sinceLastTransfer(events: EventRow[]): EventRow[] {
  const mine = events.filter(fromWorker).sort(byTime);
  let from = 0;
  mine.forEach((e, i) => {
    if (e.type === CONFERENCE_ENDED) from = i + 1;
  });
  return mine.slice(from);
}

/**
 * How the latest warm transfer in the call's current conference stands, from one call's events
 * (any order) and who holds the call now. Null when the Worker never rang anyone into it.
 *   answered  answered_by is the teammate it rang (warmLegStatus moves it on their answer)
 *   missed    their leg ended unanswered: a warm_transfer_missed for the same leg. The leg's
 *             CallSid ties the two together, because a fast decline can be written before the
 *             warm_transfer event (that one goes in after the app has its answer); without a
 *             CallSid on both, a missed event after it counts.
 *   ringing   otherwise
 */
export function warmStateOf(events: EventRow[], answeredBy: string | null): WarmInfo | null {
  const mine = sinceLastTransfer(events);
  let wi = -1;
  mine.forEach((e, i) => {
    if (e.type === "warm_transfer") wi = i;
  });
  if (wi < 0) return null;
  const w = mine[wi];
  const to = str(w.data?.to);
  if (to && answeredBy === to) return { to_user_id: to, state: "answered", at: w.at };
  const sid = str(w.data?.sid);
  const missed = mine.some((e, i) => {
    if (e.type !== "warm_transfer_missed") return false;
    const leg = str(e.data?.sid);
    return sid && leg ? leg === sid : i > wi;
  });
  return { to_user_id: to, state: missed ? "missed" : "ringing", at: w.at };
}

/** The latest warm transfer on each of these calls, in one read. Calls with none are absent. */
export async function warmStates(admin: Admin, calls: Pick<CallRow, "id" | "answered_by">[]): Promise<Map<string, WarmInfo>> {
  const out = new Map<string, WarmInfo>();
  if (!calls.length) return out;
  const rows = (must(
    await admin.from("phone_call_events").select("call_id, type, at, data")
      .in("call_id", calls.map((c) => c.id)).in("type", WARM_TYPES)
      .order("at", { ascending: false }).limit(200),
    "read warm transfer events",
  ) as EventRow[] | null) ?? [];
  for (const c of calls) {
    const info = warmStateOf(rows.filter((r) => r.call_id === c.id), c.answered_by);
    if (info) out.set(c.id, info);
  }
  return out;
}

/**
 * Is a Resume still on its way in? In a conference nobody has started, resume redirects the
 * agent's leg back in with startConferenceOnEnter=true, and until that leg lands nothing proves
 * the conference started (conference.ts hasStarted). True when the Worker's latest hold/resume
 * on the call, since its latest cold transfer, is a resume (resume writes that event before it
 * answers, so a Hold pressed after it always sees it). A Resume from before a cold transfer was
 * in a conference that is over; the one Hold is pressed in now was entered by a move, and
 * nobody has resumed it.
 */
export async function resumeInFlight(admin: Admin, callId: string): Promise<boolean> {
  const rows = (must(
    await admin.from("phone_call_events").select("call_id, type, at, data").eq("call_id", callId)
      .in("type", ["hold", "resume", CONFERENCE_ENDED]).order("at", { ascending: false }).limit(10),
    "read hold events",
  ) as EventRow[] | null) ?? [];
  return sinceLastTransfer(rows).filter((e) => e.type === "hold" || e.type === "resume").pop()?.type === "resume";
}

/**
 * What the Worker records when a call's conference has started: Twilio's `start` event, or a
 * warm-transfer teammate answering (they join with start=true beside the customer; conference.ts).
 */
export const CONFERENCE_STARTED = "conference_started";

/**
 * Record that THIS conference has started. Unlike addCallEvent a failed insert throws: a start
 * nobody recorded is what makes Hold and Resume fall back to what is safe either way.
 */
export async function recordConferenceStart(admin: Admin, callId: string, conferenceSid: string): Promise<void> {
  must(await admin.from("phone_call_events").insert({ call_id: callId, type: CONFERENCE_STARTED, data: { conference_sid: conferenceSid } }), "record conference start");
}

/**
 * Is THIS conference recorded as started? Keyed by its ConferenceSid, because a call can have
 * one conference after another under the same name (a cold transfer ends the first). The event
 * is never removed: nothing un-starts a conference.
 */
export async function conferenceStarted(admin: Admin, callId: string, conferenceSid: string): Promise<boolean> {
  const rows = (must(
    await admin.from("phone_call_events").select("call_id, type, at, data").eq("call_id", callId)
      .eq("type", CONFERENCE_STARTED).eq("data->>conference_sid", conferenceSid).limit(10),
    "read conference start",
  ) as EventRow[] | null) ?? [];
  return rows.some((e) => fromWorker(e) && e.data?.conference_sid === conferenceSid);
}
