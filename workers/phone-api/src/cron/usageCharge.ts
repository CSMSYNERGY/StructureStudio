// ════════════════════════════════════════════════════════════════════════════════════
// USAGE CHARGES · every call and text, one wallet line each, at Twilio's cost × the markup
// ════════════════════════════════════════════════════════════════════════════════════
//
// Runs every 5 minutes from the tick (index.ts, minute % 5 == 2). Part 1 of the usage-billing
// plan; the database half is migration 259. It replaced the daily combined minute debit, which
// never ran live: Carolyn wants each call and text as its own line under Transactions, like
// GoHighLevel, priced from what Twilio actually charged us.
//
// ── THE QUEUE ───────────────────────────────────────────────────────────────────────────
//   1. usage_charges_enqueue(now − 3 days, 500): one set-based insert of every finished call
//      and sent/received text not queued yet (unique on source + source_id, so a rerun adds
//      nothing). Three days back is the catch-up window for a run that failed or never ran.
//   2. usage_charges_claim(≤ 10 at a time, ≤ 40 per run, lease 240 s): FOR UPDATE SKIP LOCKED,
//      so two overlapping runs never take the same row; a run that dies leaves its rows to come
//      back when the lease runs out.
//   3. Per row: Twilio's cost, whether it is billable, and then exactly one of the states below.
//   4. Once per tenant charged this run whose spendable balance is now under its auto top-up
//      threshold: one POST to the wallet-autotopup edge function (wallet.ts requestAutoTopup),
//      which holds the card secrets and decides for itself (threshold, cooldown, card on file).
//
// ── THE STATES (each one final, except pending) ─────────────────────────────────────────
//   not_billable  refused before it was placed (error_code), no talk time, a failed or
//                 undelivered text, or a missed call while bill_unanswered_calls is off. Its
//                 cost is still recorded: that is the cost we absorb.
//   exempt        our own and non-billable accounts (metered_exempt, billing_exempt): the cost
//                 and the would-be charge are recorded, no wallet line, never refused.
//   shadow        COST CAPTURE. Billable, but the meter is not armed for it: the env rail
//                 PHONE_USAGE_METERS is not "on", or phone_usage_armed(client, meter) says no
//                 (no markup, no armed_at, the meter inactive and the tenant not on the pilot
//                 list; the pilot list covers the four call and text meters only, migration
//                 263), or it happened before armed_at. Records the cost and what it WOULD
//                 have charged at today's markup (null while no markup is set). This is what
//                 runs from deploy day, so Carolyn has real numbers before she arms anything.
//   charged       wallet_usage_debit posted the line (idempotency key usage:call:<id> /
//                 usage:sms:<id>, so a rerun, a retry or a second run can never charge twice).
//                 Never refused for funds: the call was already made, and the wallet floor
//                 (wallet.ts) stops the next outbound one.
//   pending       not decidable yet (Twilio has not priced a leg, the call is too fresh, a read
//                 failed): next_try_at moves on by 3, 10, 30, 60, 120, 240 minutes.
//   failed        gave up after MAX_ATTEMPTS, or the call/text row is gone. Logged as an error.
//
// ── THE LEDGER WINS ─────────────────────────────────────────────────────────────────────
// A debit can post while its row stays pending: the RPC commits and its reply is lost (the
// client resolves {error}, so this reads as a failure and retries), the row update after it
// fails, or the run dies in between. The retry is minutes to hours later, and by then the
// cost may be re-priced (a leg Twilio had not priced was estimated the first time), the markup
// edited, the tenant made exempt, or armed_at cleared. Whatever it decides now, the money
// already moved, so usage_charges must say what the LEDGER says, or every report and refund
// decision read from it is wrong:
//   * a replayed debit answers the ORIGINAL line's exact charge and cost (migration 259), and
//     those are what the row records, not this attempt's figures;
//   * a row claimed before (attempts > 1) that would now settle as anything but charged is
//     checked against the ledger first (one read per batch, readLedger); a posted line makes
//     it 'charged' with that line's id and figures, and logs a warning naming what this run
//     would have decided, since that may be a charge to refund.
//
// ── TWILIO'S COST ───────────────────────────────────────────────────────────────────────
// A call is several Twilio calls ("legs"), each priced on its own, some minutes after it ends:
//   * the row's twilio_call_sid (the customer) and client_call_sid (the app);
//   * every leg SID the Worker's own phone_call_events carry in data.sid (status callbacks,
//     warm transfer and its teammate leg, a handoff's new leg), never an app-posted mark;
//   * the <Dial> children of those, and THEIR children, three levels down: a cold transfer
//     dials again from the customer's leg, which for an outbound call is itself a child;
//     and each leg's parent, which after a cold transfer may be on no row and in no event;
//   * the voicemail recording's own price;
//   * conference minutes, which Twilio bills separately and no leg resource shows: when the
//     call was ever moved into its conference (hold, warm transfer, a finished device switch),
//     an ESTIMATE of 1,800 micros per participant-minute for every leg that connected
//     (cost_source 'mixed').
// A leg that never connected (busy, no-answer, canceled) costs nothing whatever its price says.
// A connected leg Twilio has not priced keeps the row pending, until fallback_after_hours
// (default 6) after the call ended: then the missing pieces are ESTIMATED at the fallback
// rates (cost_source 'estimate'). A text is its message price plus the carrier-fee estimate
// per segment (carrier fees are billed separately and never appear on the message). A photo
// text received (num_media > 0) that Twilio has not priced is estimated at Twilio's published
// inbound MMS price, MMS_IN_MICROS a message, not at the text rate per segment (outbound MMS
// can't be sent: routes/sms.ts refuses media).
//
// THE CHARGE = round(cost × markup), half up; with a ceiling set, at most ceiling × units
// (minutes or segments), so Carolyn can promise "never more than you pay now". The markup is
// the ONLY multiplier: it lands on the whole cost (every leg, the conference and voicemail
// estimates, the carrier fee), whether Twilio priced it or the fallback did. Carolyn's answer
// of 2026-10-06 is ×1.25, the whole margin, kept when Twilio starts returning real prices. It
// is an operator setting (Admin › Billing); nothing in this file knows the number.
//
// ── THE REQUEST CAP ─────────────────────────────────────────────────────────────────────
// About 300 outside requests per run (Supabase and Twilio together), well inside a Worker's
// subrequest allowance even with the sweep sharing the tick. Claiming stops when fewer than
// CLAIM_MIN_LEFT remain; a row is not started without ROW_MIN; a row that runs out half way is
// released (lease cleared) with every row after it, for the next run, and that is logged.
// Writes that finish a row already priced (the debit, the row update) are always allowed.
//
// ── CALL RECORDINGS AND TRANSCRIPTS (release B2, migration 263) ─────────────────────────
// Two more sources, both keyed on phone_call_recordings.id (the unique source + source_id keeps
// them apart), each its own wallet line, by the same states and the same ledger rules:
//   recording      Twilio's price for the recording (fetchRecording), or RECORDING_MIN_MICROS a
//                  minute once fallback_after_hours have passed unpriced (or it was deleted
//                  first). Meter call_recording. Billable when it completed with any length.
//   transcription  the transcript and summary together: stt_cost_micros + llm_cost_micros, both
//                  the Worker's and the edge function's own estimates (cost_source 'estimate').
//                  Meter call_transcription. Queued only once the summary has settled.
// Both meters ship INACTIVE and INVISIBLE, so until Carolyn prices and arms them every one is a
// shadow row with its cost. A pilot of call and text billing does not arm them: 263 re-issued
// phone_usage_armed so the pilot list counts for the four call and text meters only, and these
// two charge only once their own usage_prices row is active. callCost stays voicemail-only for recordings: a call recording is
// never counted in its call's line, only in its own.
//
// phone_calls.cost_cents is written too (Twilio's cost, rounded to cents). That column is
// server-only: phone_calls has RLS on, no policies and no tenant grants (migration 254), and
// every tenant-facing read names its columns (db.ts CALL_COLUMNS, portal-settings, crmFeed),
// none of them cost_cents. The write does fire the row's realtime broadcast (ids only), so the
// apps re-read that one call once.

import type { Env } from "../env";
import { must, patchCall, type Admin } from "../db";
import { DEVICE_SWITCH } from "../handoff";
import { logFault } from "../log";
import {
  fetchCallCost, fetchMessage, fetchRecording, listChildCalls, listUsageDaily, twilioConfigured,
  type TwilioLegCost,
} from "../twilioRest";
import { requestAutoTopup } from "../wallet";

/** Outside requests per run, Supabase and Twilio together. */
export const REQUEST_CAP = 300;
export const CLAIM_MAX = 40;
export const CLAIM_BATCH = 10;
export const LEASE_S = 240;
export const ENQUEUE_LIMIT = 500;
export const ENQUEUE_DAYS = 3;
/** Minutes until the next try of a pending row, by its attempts (the claim counts them). */
export const BACKOFF_MIN = [3, 10, 30, 60, 120, 240];
/** A call or text this fresh is left a moment: its row may still be settling (voicemail). */
export const SETTLE_MS = 2 * 60_000;
/**
 * A MISSED call waits out one recording sweep (every 15 minutes, cron/sweep.ts) as well. It
 * turns into a voicemail when the recording is filed: within seconds by the Record action
 * normally, but by the sweep when that write failed, and a missed call settles as
 * not_billable, which is final. Without the wait, that voicemail would never be charged.
 */
export const MISSED_SETTLE_MS = 20 * 60_000;
/** Pending rows that keep failing (not merely unpriced) give up here. */
export const MAX_ATTEMPTS = 30;
export const MAX_LEGS = 16;
export const MAX_DEPTH = 3;
/** Twilio's conference price, per participant-minute. */
export const CONFERENCE_MIN_MICROS = 1800;
/** Twilio's recording price per minute, for a recording it has not priced by the fallback. */
export const RECORDING_MIN_MICROS = 2500;
/**
 * Twilio's published US price for a photo text RECEIVED (MMS), per message, for one it has not
 * priced by the fallback. Without it an inbound MMS was estimated as a text (8,300 a segment).
 * Outbound MMS can't be sent (routes/sms.ts refuses media), so it has no constant.
 */
export const MMS_IN_MICROS = 16500;
/** Budget a row needs before it is started. */
const ROW_MIN = 12;
/** Budget that must be left to claim another batch. */
const CLAIM_MIN_LEFT = 60;
/** Kept back from reads for the writes that finish rows, the release and the top-ups. */
const TAIL_RESERVE = 20;

// ── Settings (phone_billing_settings, one row) ──────────────────────────────────────

export interface BillingSettings {
  /** 1.0–10.0; null = not set, so nothing can be armed and shadow rows carry no charge. */
  markup: number | null;
  floorCents: number;
  carrierFeeOutMicros: number;
  carrierFeeInMicros: number;
  fallbackOutMinMicros: number;
  fallbackInMinMicros: number;
  fallbackClientMinMicros: number;
  fallbackSmsSegMicros: number;
  fallbackAfterHours: number;
  ceilingMinMicros: number | null;
  ceilingSegMicros: number | null;
  billUnansweredCalls: boolean;
  armedAt: string | null;
}

export const DEFAULT_SETTINGS: BillingSettings = {
  markup: null,
  floorCents: 500,
  carrierFeeOutMicros: 4500,
  carrierFeeInMicros: 3500,
  fallbackOutMinMicros: 14000,
  fallbackInMinMicros: 8500,
  fallbackClientMinMicros: 4000,
  fallbackSmsSegMicros: 8300,
  fallbackAfterHours: 6,
  ceilingMinMicros: null,
  ceilingSegMicros: null,
  billUnansweredCalls: false,
  armedAt: null,
};

const SETTINGS_COLUMNS =
  "markup, floor_cents, carrier_fee_out_micros, carrier_fee_in_micros, fallback_out_min_micros, fallback_in_min_micros, fallback_client_min_micros, fallback_sms_seg_micros, fallback_after_hours, ceiling_min_micros, ceiling_seg_micros, bill_unanswered_calls, armed_at";

/** The row as read (numeric and bigint may arrive as strings), with the defaults filled in. */
export function settingsFrom(row: Record<string, unknown> | null | undefined): BillingSettings {
  if (!row) return { ...DEFAULT_SETTINGS };
  const n = (v: unknown, d: number): number => {
    const x = v === null || v === undefined || v === "" ? NaN : Number(v);
    return Number.isFinite(x) && x >= 0 ? x : d;
  };
  const opt = (v: unknown): number | null => {
    const x = v === null || v === undefined || v === "" ? NaN : Number(v);
    return Number.isFinite(x) && x >= 0 ? x : null;
  };
  const m = opt(row.markup);
  const armed = typeof row.armed_at === "string" && Number.isFinite(Date.parse(row.armed_at)) ? row.armed_at : null;
  return {
    markup: m !== null && m >= 1 && m <= 10 ? m : null,
    floorCents: n(row.floor_cents, DEFAULT_SETTINGS.floorCents),
    carrierFeeOutMicros: n(row.carrier_fee_out_micros, DEFAULT_SETTINGS.carrierFeeOutMicros),
    carrierFeeInMicros: n(row.carrier_fee_in_micros, DEFAULT_SETTINGS.carrierFeeInMicros),
    fallbackOutMinMicros: n(row.fallback_out_min_micros, DEFAULT_SETTINGS.fallbackOutMinMicros),
    fallbackInMinMicros: n(row.fallback_in_min_micros, DEFAULT_SETTINGS.fallbackInMinMicros),
    fallbackClientMinMicros: n(row.fallback_client_min_micros, DEFAULT_SETTINGS.fallbackClientMinMicros),
    fallbackSmsSegMicros: n(row.fallback_sms_seg_micros, DEFAULT_SETTINGS.fallbackSmsSegMicros),
    fallbackAfterHours: n(row.fallback_after_hours, DEFAULT_SETTINGS.fallbackAfterHours),
    ceilingMinMicros: opt(row.ceiling_min_micros),
    ceilingSegMicros: opt(row.ceiling_seg_micros),
    billUnansweredCalls: row.bill_unanswered_calls === true,
    armedAt: armed,
  };
}

// ── Small pure pieces (exported for the tests) ──────────────────────────────────────

/** round(cost × markup), half up, in integer arithmetic; then at most ceiling × units. */
export function chargeFor(costMicros: number, markup: number, ceilingPerUnit: number | null, units: number): number {
  const milli = Math.round(markup * 1000);
  let charge = Math.floor((Math.max(0, costMicros) * milli + 500) / 1000);
  if (ceilingPerUnit !== null) charge = Math.min(charge, Math.max(0, ceilingPerUnit) * Math.max(0, units));
  return charge;
}

/** Minutes until the next try, by the attempts the claim has counted (1 on the first). */
export function backoffMinutes(attempts: number): number {
  const i = Math.min(Math.max(1, attempts), BACKOFF_MIN.length) - 1;
  return BACKOFF_MIN[i];
}

/** (555) 123-4567 for a +1 number; anything else (E.164 abroad, "Anonymous") as it is. */
export function displayNumber(v: string | null | undefined): string {
  const s = String(v ?? "").trim();
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(s);
  if (m) return `(${m[1]}) ${m[2]}-${m[3]}`;
  return s || "an unknown number";
}

/** Yesterday, UTC, as YYYY-MM-DD. */
export function previousUtcDay(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1)).toISOString().slice(0, 10);
}

export type Meter = "voice_minute" | "voice_minute_in" | "sms_segment" | "sms_in" | "call_recording" | "call_transcription";

export type ChargeSource = "call" | "sms" | "recording" | "transcription";

/** A recording and its transcript are one meter each, whichever way the call went. */
export function meterFor(source: ChargeSource, direction: "in" | "out"): Meter {
  if (source === "recording") return "call_recording";
  if (source === "transcription") return "call_transcription";
  if (source === "call") return direction === "out" ? "voice_minute" : "voice_minute_in";
  return direction === "out" ? "sms_segment" : "sms_in";
}

/**
 * The debit's idempotency key: usage:call:<phone_calls.id>, usage:sms:<sms_messages.id>,
 * usage:recording:<phone_call_recordings.id> or usage:transcription:<phone_call_recordings.id>.
 */
export function idemFor(row: Pick<ChargeRow, "source" | "source_id">): string {
  return `usage:${row.source}:${row.source_id}`;
}

/** The per-unit ceiling a source's charge is held to: calls by the minute, texts by the segment, recordings none. */
function ceilingFor(source: ChargeSource, s: BillingSettings): number | null {
  if (source === "call") return s.ceilingMinMicros;
  if (source === "sms") return s.ceilingSegMicros;
  return null;
}

// ── Rows ────────────────────────────────────────────────────────────────────────────

export interface ChargeRow {
  id: number;
  source: ChargeSource;
  source_id: string;
  client_id: string;
  direction: "in" | "out";
  occurred_at: string;
  state: string;
  attempts: number;
  next_try_at?: string;
}

export interface UsageCall {
  id: string;
  client_id: string;
  direction: "in" | "out";
  from_e164: string;
  to_e164: string;
  twilio_call_sid: string | null;
  client_call_sid: string | null;
  transfer_state: string | null;
  status: string;
  started_at: string;
  answered_at: string | null;
  ended_at: string | null;
  duration_s: number | null;
  cost_cents: number | null;
  error_code: string | null;
  phone_voicemails: VmJoin | VmJoin[] | null;
}

interface VmJoin {
  recording_sid: string | null;
  duration_s: number | null;
}

interface UsageEvent {
  call_id: string;
  type: string;
  data: Record<string, unknown> | null;
}

export interface UsageSms {
  id: string;
  client_id: string;
  direction: "in" | "out";
  status: string;
  from_number: string;
  to_number: string;
  provider_sid: string | null;
  num_segments: number | null;
  /** Photos that came with an inbound text (migration 254; 0 on every other text). */
  num_media: number | null;
  created_at: string;
}

/** A call recording and what its transcript and summary cost (migration 263). */
export interface UsageRecording {
  id: string;
  client_id: string;
  recording_sid: string | null;
  status: string;
  duration_s: number | null;
  completed_at: string | null;
  deleted_at: string | null;
  transcript_status: string;
  summary_status: string;
  stt_cost_micros: number | string | null;
  llm_cost_micros: number | string | null;
  phone_calls: RecCallJoin | RecCallJoin[] | null;
}

interface RecCallJoin {
  direction: "in" | "out";
  from_e164: string;
  to_e164: string;
}

const CALL_SELECT =
  "id, client_id, direction, from_e164, to_e164, twilio_call_sid, client_call_sid, transfer_state, status, started_at, answered_at, ended_at, duration_s, cost_cents, error_code, phone_voicemails(recording_sid, duration_s)";
const SMS_SELECT = "id, client_id, direction, status, from_number, to_number, provider_sid, num_segments, num_media, created_at";
const REC_SELECT =
  "id, client_id, recording_sid, status, duration_s, completed_at, deleted_at, transcript_status, summary_status, stt_cost_micros, llm_cost_micros, phone_calls(direction, from_e164, to_e164)";

const FINAL_CALL = new Set(["completed", "missed", "voicemail", "no_answer", "busy", "failed"]);
const UNANSWERED = new Set(["missed", "no_answer", "busy", "failed"]);
/** The Worker's events that mean the call was moved into its conference at some point. */
const CONFERENCE_EVENTS = new Set(["hold", "warm_transfer", "conference_started", "handed_over", "conference_voicemail", "conference_ended"]);
/**
 * A device switch that finished (handoff.ts completeHandoff step 4): the new leg was connected in
 * the call's conference before the swap, so the call ran there from then on, whether or not
 * Twilio's conference-start callback was recorded. Only 'done': a move that rang and was missed,
 * canceled or failed proves no conference by itself (one that did put the call there leaves
 * conference_started or hold).
 */
const movedIntoConference = (e: UsageEvent): boolean => e.type === DEVICE_SWITCH && e.data?.phase === "done";
const LIVE_LEG = new Set(["queued", "initiated", "ringing", "in-progress"]);
const LIVE_SMS = new Set(["queued", "sending", "accepted", "scheduled", "receiving"]);
const CALL_SID_RE = /^CA[0-9a-f]{32}$/i;

const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? v[0] ?? null : v ?? null);

// ── Billable? ───────────────────────────────────────────────────────────────────────

export interface Billability {
  billable: boolean;
  /** Minutes (calls) or segments (texts): what the line says and what a ceiling multiplies. */
  units: number;
  why: string;
}

/**
 * Talk time, or a voicemail, is billed. Never a call refused before it was placed (error_code:
 * wallet_empty, minute_cap, ...). Missed, unanswered, busy and failed only with
 * bill_unanswered_calls on. Minutes are rounded up per call, the way Twilio bills.
 *
 * Talk time is a COMPLETED call's duration_s, and answered_at is deliberately not asked.
 * Twilio's "completed" means answered and ended normally (a leg nobody picked up ends
 * no-answer, busy, canceled or failed), and the Worker writes completed only from such a leg
 * or from a row already in progress. answered_at is a separate write of the Worker's own
 * (the 'answered' callback); when that write is lost, the 'completed' callback still lands,
 * because its filter takes a 'ringing' row, and a call Twilio billed must not go free.
 */
export function callBillability(call: Pick<UsageCall, "status" | "duration_s" | "error_code">, vmDurationS: number | null, s: BillingSettings): Billability {
  const talk = Number(call.duration_s) || 0;
  if (call.error_code) return { billable: false, units: 0, why: "refused before it was placed" };
  if (call.status === "voicemail") return { billable: true, units: Math.max(1, Math.ceil((Number(vmDurationS) || 0) / 60)), why: "voicemail" };
  if (call.status === "completed") {
    if (talk > 0) return { billable: true, units: Math.ceil(talk / 60), why: "talk" };
    return { billable: false, units: 0, why: "no talk time" };
  }
  if (UNANSWERED.has(call.status)) {
    return s.billUnansweredCalls
      ? { billable: true, units: Math.max(1, Math.ceil(talk / 60)), why: "unanswered (billed)" }
      : { billable: false, units: 0, why: "unanswered" };
  }
  return { billable: false, units: 0, why: `status ${call.status}` };
}

/** A sent or delivered text out, a received text in. Never a failed or undelivered one. */
export function smsBillable(direction: "in" | "out", status: string): boolean {
  return direction === "out" ? status === "sent" || status === "delivered" : status === "received";
}

/** The wallet line, written on the server. */
export function callMemo(call: Pick<UsageCall, "direction" | "status" | "from_e164" | "to_e164">, units: number): string {
  if (call.direction === "out") return `Outbound call to ${displayNumber(call.to_e164)} · ${units} min`;
  if (call.status === "voicemail") return `Missed call from ${displayNumber(call.from_e164)} · voicemail ${units} min`;
  if (UNANSWERED.has(call.status)) return `Missed call from ${displayNumber(call.from_e164)} · ${units} min`;
  return `Incoming call from ${displayNumber(call.from_e164)} · ${units} min`;
}

export function smsMemo(direction: "in" | "out", other: string, segments: number): string {
  const seg = `${segments} segment${segments === 1 ? "" : "s"}`;
  return direction === "out" ? `Text to ${displayNumber(other)} · ${seg}` : `Text from ${displayNumber(other)} · ${seg}`;
}

/** A call recording's or transcript's wallet line, naming the call it belongs to. */
export function recordingMemo(source: "recording" | "transcription", call: RecCallJoin | null, units: number): string {
  const what = source === "recording" ? "Call recording" : "Call transcript and summary";
  if (!call) return `${what} · ${units} min`;
  const with_ = call.direction === "out" ? `call to ${displayNumber(call.to_e164)}` : `call from ${displayNumber(call.from_e164)}`;
  return `${what}, ${with_} · ${units} min`;
}

// ── The run ─────────────────────────────────────────────────────────────────────────

class BudgetSpent extends Error {
  constructor() {
    super("request cap reached");
    this.name = "BudgetSpent";
  }
}

class RequestBudget {
  used = 0;
  /** Kept back for the writes (TAIL_RESERVE, less for a small test cap). */
  readonly tail: number;
  /** Left over that a new batch may still be claimed (CLAIM_MIN_LEFT, less for a small cap). */
  readonly claimFloor: number;
  constructor(readonly cap: number) {
    this.tail = Math.min(TAIL_RESERVE, Math.floor(cap / 5));
    this.claimFloor = Math.min(CLAIM_MIN_LEFT, Math.floor(cap / 4));
  }
  left(): number {
    return this.cap - this.used;
  }
  /** A request that can wait for the next run: refused once only the tail reserve is left. */
  spend(): void {
    if (this.used >= this.cap - this.tail) throw new BudgetSpent();
    this.used++;
  }
  /** A request that finishes work already done (a debit, a row update): always made, counted. */
  spendTail(n = 1): void {
    this.used += n;
  }
}

interface Run {
  env: Env;
  admin: Admin;
  now: Date;
  metersOn: boolean;
  settings: BillingSettings;
  budget: RequestBudget;
  exempt: Map<string, boolean>;
  armed: Map<string, boolean>;
  /** Ledger lines already posted for claimed rows, by usage_charges.id (readLedger). */
  ledger: Map<number, LedgerLine>;
  /** Tenants a line was posted for this run (the auto top-up check). */
  charged: Set<string>;
}

/** A posted usage debit, as the queue row must record it. */
interface LedgerLine {
  txId: number | string;
  /** What the line charged, in positive micros (−amount_exact_micros). */
  chargeMicros: number;
  /** Our cost as the line recorded it; null when the line has none. */
  costMicros: number | null;
  memo: string | null;
  units: number | null;
  unit: "minute" | "segment" | null;
}

export interface UsageRunCounts {
  enqueued: number;
  claimed: number;
  charged: number;
  shadow: number;
  exempt: number;
  not_billable: number;
  pending: number;
  failed: number;
  deferred: number;
  topups: number;
  requests: number;
}

export type UsageRunSummary =
  | { ran: false; reason: "switched_off" | "error"; counts?: UsageRunCounts }
  | ({ ran: true } & UsageRunCounts);

type FinalState = "charged" | "shadow" | "exempt" | "not_billable" | "failed";

export async function runUsageCharges(env: Env, admin: Admin, now = new Date(), opts: { requestCap?: number } = {}): Promise<UsageRunSummary> {
  const metersOn = env.PHONE_USAGE_METERS === "on";
  if (!metersOn && env.PHONE_USAGE_COST_CAPTURE === "off") return { ran: false, reason: "switched_off" };
  const budget = new RequestBudget(opts.requestCap ?? REQUEST_CAP);
  const counts: UsageRunCounts = {
    enqueued: 0, claimed: 0, charged: 0, shadow: 0, exempt: 0, not_billable: 0, pending: 0, failed: 0, deferred: 0, topups: 0, requests: 0,
  };
  const run: Run = {
    env, admin, now, metersOn, settings: DEFAULT_SETTINGS, budget,
    exempt: new Map(), armed: new Map(), ledger: new Map(), charged: new Set(),
  };
  let failure: string | null = null;
  try {
    budget.spend();
    const enq = must(
      await admin.rpc("usage_charges_enqueue", { p_since: new Date(now.getTime() - ENQUEUE_DAYS * 86_400_000).toISOString(), p_limit: ENQUEUE_LIMIT }),
      "usage_charges_enqueue",
    );
    counts.enqueued = Number(enq) || 0;
    budget.spend();
    run.settings = settingsFrom(must(
      await admin.from("phone_billing_settings").select(SETTINGS_COLUMNS).limit(1).maybeSingle(),
      "read phone_billing_settings",
    ) as Record<string, unknown> | null);

    while (counts.claimed < CLAIM_MAX && budget.left() >= budget.claimFloor) {
      const want = Math.min(CLAIM_BATCH, CLAIM_MAX - counts.claimed);
      budget.spend();
      const rows = (must(await admin.rpc("usage_charges_claim", { p_limit: want, p_lease_s: LEASE_S }), "usage_charges_claim") as ChargeRow[] | null) ?? [];
      counts.claimed += rows.length;
      if (!rows.length) break;
      const stopped = await processBatch(run, rows, counts);
      if (stopped || rows.length < want) break;
    }
  } catch (e) {
    failure = (e as Error)?.message ?? String(e);
    // Every 5 minutes, so throttled: before migration 259 is applied this is every run.
    await logFault({ code: "usage_charge_failed", message: `Usage charge run failed: ${failure}`, throttleMs: 60 * 60_000 });
  }
  // Lines already posted stay posted whatever happened after them, so the top-up check runs
  // even after a failure.
  try {
    counts.topups = await autoTopUps(run);
  } catch (e) {
    await logFault({ code: "usage_autotopup_check_failed", message: (e as Error)?.message ?? String(e), throttleMs: 60 * 60_000 });
  }
  counts.requests = budget.used;
  if (counts.claimed || counts.enqueued) {
    console.log(`[phone-api] usage charges: ${JSON.stringify(counts)}`);
  }
  return failure ? { ran: false, reason: "error", counts } : { ran: true, ...counts };
}

/** One claimed batch. True when the request cap stopped it (the rest were released). */
async function processBatch(run: Run, rows: ChargeRow[], counts: UsageRunCounts): Promise<boolean> {
  let calls: Map<string, UsageCall>;
  let events: Map<string, UsageEvent[]>;
  let msgs: Map<string, UsageSms>;
  let recs: Map<string, UsageRecording>;
  try {
    const callIds = rows.filter((r) => r.source === "call").map((r) => r.source_id);
    const smsIds = rows.filter((r) => r.source === "sms").map((r) => r.source_id);
    const recIds = [...new Set(rows.filter((r) => r.source === "recording" || r.source === "transcription").map((r) => r.source_id))];
    calls = callIds.length ? await readCalls(run, callIds) : new Map();
    events = callIds.length ? await readEvents(run, callIds) : new Map();
    msgs = smsIds.length ? await readMessages(run, smsIds) : new Map();
    recs = recIds.length ? await readRecordings(run, recIds) : new Map();
    await loadExemptions(run, [...new Set(rows.map((r) => r.client_id))]);
    await readLedger(run, rows);
  } catch (e) {
    if (!(e instanceof BudgetSpent)) throw e;
    await release(run, rows, counts);
    return true;
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (run.budget.left() - run.budget.tail < ROW_MIN) {
      await release(run, rows.slice(i), counts);
      return true;
    }
    try {
      const state = row.source === "call"
        ? await chargeCall(run, row, calls.get(row.source_id) ?? null, events.get(row.source_id) ?? [])
        : row.source === "sms"
          ? await chargeSms(run, row, msgs.get(row.source_id) ?? null)
          : row.source === "recording"
            ? await chargeRecording(run, row, recs.get(row.source_id) ?? null)
            : await chargeTranscription(run, row, recs.get(row.source_id) ?? null);
      counts[state]++;
    } catch (e) {
      if (e instanceof BudgetSpent) {
        await release(run, rows.slice(i), counts);
        return true;
      }
      counts[await retryLater(run, row, (e as Error)?.message ?? String(e))]++;
    }
  }
  return false;
}

async function readCalls(run: Run, ids: string[]): Promise<Map<string, UsageCall>> {
  run.budget.spend();
  const rows = (must(await run.admin.from("phone_calls").select(CALL_SELECT).in("id", ids), "read calls to charge") as UsageCall[] | null) ?? [];
  return new Map(rows.map((r) => [r.id, r]));
}

async function readRecordings(run: Run, ids: string[]): Promise<Map<string, UsageRecording>> {
  run.budget.spend();
  const rows = (must(await run.admin.from("phone_call_recordings").select(REC_SELECT).in("id", ids), "read call recordings to charge") as UsageRecording[] | null) ?? [];
  return new Map(rows.map((r) => [r.id, r]));
}

/** The batch's events, paged (PostgREST caps a response at 1000 rows). */
async function readEvents(run: Run, ids: string[]): Promise<Map<string, UsageEvent[]>> {
  const out = new Map<string, UsageEvent[]>();
  for (let from = 0; ; from += 1000) {
    run.budget.spend();
    const rows = (must(
      await run.admin.from("phone_call_events").select("call_id, type, data").in("call_id", ids)
        .order("id", { ascending: true }).range(from, from + 999),
      "read call events to charge",
    ) as UsageEvent[] | null) ?? [];
    for (const r of rows) {
      const list = out.get(r.call_id) ?? [];
      list.push(r);
      out.set(r.call_id, list);
    }
    if (rows.length < 1000) break;
  }
  return out;
}

async function readMessages(run: Run, ids: string[]): Promise<Map<string, UsageSms>> {
  run.budget.spend();
  const rows = (must(await run.admin.from("sms_messages").select(SMS_SELECT).in("id", ids), "read texts to charge") as UsageSms[] | null) ?? [];
  return new Map(rows.map((r) => [r.id, r]));
}

/** metered_exempt or billing_exempt, for the tenants not looked up yet this run. */
async function loadExemptions(run: Run, clientIds: string[]): Promise<void> {
  const ids = clientIds.filter((c) => !run.exempt.has(c));
  if (!ids.length) return;
  run.budget.spend();
  const accts = (must(
    await run.admin.from("wallet_accounts").select("client_id, metered_exempt").in("client_id", ids),
    "read metered_exempt",
  ) as { client_id: string; metered_exempt?: boolean }[] | null) ?? [];
  run.budget.spend();
  const cs = (must(
    await run.admin.from("client_settings").select("client_id, billing_exempt").in("client_id", ids),
    "read billing_exempt",
  ) as { client_id: string; billing_exempt?: boolean }[] | null) ?? [];
  for (const id of ids) run.exempt.set(id, false);
  for (const a of accts) if (a.metered_exempt === true) run.exempt.set(a.client_id, true);
  for (const c of cs) if (c.billing_exempt === true) run.exempt.set(c.client_id, true);
}

/**
 * The debits already posted for rows claimed before (attempts > 1): THE LEDGER WINS, in the
 * header. One read per batch, none for a batch of first attempts, which cannot have posted
 * anything. Filtered on client_id as well as the key, so it reads through the
 * (client_id, idempotency_key) index. A released line does not count, as in the RPC's replay,
 * and of two lines the later one wins, as there too.
 */
async function readLedger(run: Run, rows: ChargeRow[]): Promise<void> {
  const again = rows.filter((r) => r.attempts > 1);
  if (!again.length) return;
  const byKey = new Map(again.map((r) => [`${r.client_id}\n${idemFor(r)}`, r]));
  run.budget.spend();
  const lines = (must(
    await run.admin.from("wallet_transactions")
      .select("id, client_id, idempotency_key, amount_exact_micros, cost_micros, memo, usage")
      .in("client_id", [...new Set(again.map((r) => r.client_id))])
      .in("idempotency_key", again.map(idemFor))
      .neq("state", "released")
      .order("id", { ascending: true }),
    "read ledger lines of retried usage charges",
  ) as RawLine[] | null) ?? [];
  for (const l of lines) {
    const row = byKey.get(`${l.client_id}\n${l.idempotency_key}`);
    const line = row ? ledgerLine(l) : null;
    if (row && line) run.ledger.set(row.id, line);
  }
}

interface RawLine {
  id: number | string;
  client_id?: string;
  idempotency_key?: string;
  amount_exact_micros: number | string | null;
  cost_micros: number | string | null;
  memo?: string | null;
  usage?: { units?: unknown; unit?: unknown } | null;
}

function ledgerLine(l: RawLine): LedgerLine | null {
  const exact = l.amount_exact_micros === null || l.amount_exact_micros === undefined ? NaN : Number(l.amount_exact_micros);
  if (l.id === null || l.id === undefined || !Number.isFinite(exact)) return null;
  const cost = l.cost_micros === null || l.cost_micros === undefined ? NaN : Number(l.cost_micros);
  const units = Number(l.usage?.units);
  const unit = l.usage?.unit === "minute" || l.usage?.unit === "segment" ? l.usage.unit : null;
  return {
    txId: l.id,
    chargeMicros: -exact,
    costMicros: Number.isFinite(cost) ? cost : null,
    memo: typeof l.memo === "string" ? l.memo : null,
    units: Number.isFinite(units) ? units : null,
    unit,
  };
}

/** phone_usage_armed(client, meter), once per pair per run. A failed read throws (retried). */
async function isArmed(run: Run, clientId: string, meter: Meter): Promise<boolean> {
  const key = `${clientId}\n${meter}`;
  const cached = run.armed.get(key);
  if (cached !== undefined) return cached;
  run.budget.spend();
  const v = must(await run.admin.rpc("phone_usage_armed", { p_client_id: clientId, p_meter: meter }), "phone_usage_armed");
  const armed = v === true;
  run.armed.set(key, armed);
  return armed;
}

// ── Row outcomes ────────────────────────────────────────────────────────────────────

async function updateRow(run: Run, row: ChargeRow, patch: Record<string, unknown>): Promise<void> {
  run.budget.spendTail();
  // Only ever a row still pending: a duplicate run that lost the lease cannot overwrite the
  // final state the other one wrote.
  const { error } = await run.admin.from("usage_charges")
    .update({ ...patch, lease_until: null, updated_at: run.now.toISOString() })
    .eq("id", row.id).eq("state", "pending");
  if (error) {
    // The row comes back when its lease runs out; a debit already posted replays as a no-op.
    await logFault({ code: "usage_charge_update_failed", clientId: row.client_id, message: `usage_charges update failed: ${error.message}`, context: { id: row.id } });
  }
}

async function reschedule(run: Run, row: ChargeRow, atMs: number, why: string | null): Promise<"pending"> {
  await updateRow(run, row, { next_try_at: new Date(atMs).toISOString(), last_error: why ? why.slice(0, 500) : null });
  return "pending";
}

function backoffAt(run: Run, row: ChargeRow): number {
  return run.now.getTime() + backoffMinutes(row.attempts) * 60_000;
}

/** A fault on one row: try again later, or give up for good after MAX_ATTEMPTS. */
async function retryLater(run: Run, row: ChargeRow, message: string): Promise<"pending" | "failed" | "charged"> {
  if (row.attempts >= MAX_ATTEMPTS) {
    const line = run.ledger.get(row.id);
    if (line) return settleFromLedger(run, row, line, "failed", null, null);
    await updateRow(run, row, { state: "failed", last_error: message.slice(0, 500) });
    await logFault({ code: "usage_charge_gave_up", clientId: row.client_id, message: `Usage charge ${row.source} ${row.source_id} failed ${row.attempts} times: ${message}` });
    return "failed";
  }
  await logFault({ code: "usage_charge_retry", severity: "warn", clientId: row.client_id, throttleMs: 10 * 60_000, message: `Usage charge ${row.source} will be retried: ${message}` });
  return reschedule(run, row, backoffAt(run, row), message);
}

/** Leave rows for the next run: the lease is cleared, so they can be claimed straight away. */
async function release(run: Run, rows: ChargeRow[], counts: UsageRunCounts): Promise<void> {
  if (!rows.length) return;
  counts.deferred += rows.length;
  run.budget.spendTail();
  const { error } = await run.admin.from("usage_charges").update({ lease_until: null })
    .in("id", rows.map((r) => r.id)).eq("state", "pending");
  await logFault({
    code: "usage_charge_deferred", severity: "warn", throttleMs: 60 * 60_000,
    message: `The run reached its request cap (${run.budget.cap}): ${rows.length} claimed row(s) left for the next run${error ? ` (releasing them failed: ${error.message}; their lease runs out in ${LEASE_S} s)` : ""}.`,
  });
}

interface Priced {
  costMicros: number;
  costSource: "twilio" | "estimate" | "mixed";
  costDetail: Record<string, unknown>;
}

interface Decision extends Priced {
  billable: boolean;
  units: number;
  unit: "minute" | "segment";
  meter: Meter;
  refType: "phone_call" | "sms_message" | "phone_call_recording";
  idem: string;
  memo: string;
  ceilingMicros: number | null;
}

/** not_billable → exempt → shadow → charged, in that order; a line already posted wins over all. */
async function decide(run: Run, row: ChargeRow, d: Decision): Promise<FinalState> {
  const s = run.settings;
  const would = s.markup === null ? null : chargeFor(d.costMicros, s.markup, d.ceilingMicros, d.units);
  const base = {
    cost_micros: d.costMicros, cost_source: d.costSource, cost_detail: d.costDetail,
    units: d.units, unit: d.unit, memo: d.memo, last_error: null,
  };
  let state: "not_billable" | "exempt" | "shadow" | null = null;
  if (!d.billable) state = "not_billable";
  else if (run.exempt.get(row.client_id) === true) state = "exempt";
  else {
    const occurred = Date.parse(row.occurred_at);
    const shadow = !run.metersOn || s.markup === null || !s.armedAt
      || !(Number.isFinite(occurred) && occurred >= Date.parse(s.armedAt))
      || !(await isArmed(run, row.client_id, d.meter));
    if (shadow || would === null) state = "shadow";
  }
  if (state) {
    // An earlier attempt's debit is on the ledger: no setting changed since can un-post it.
    const line = run.ledger.get(row.id);
    if (line) return settleFromLedger(run, row, line, state, d, would);
    const keep = state !== "not_billable";
    await updateRow(run, row, { ...base, state, charge_micros: keep ? would : null, markup: keep ? s.markup : null });
    return state;
  }

  run.budget.spendTail();
  const { data, error } = await run.admin.rpc("wallet_usage_debit", {
    p_client_id: row.client_id,
    p_meter_kind: d.meter,
    p_charge_micros: would,
    p_cost_micros: d.costMicros,
    p_ref_type: d.refType,
    p_ref_id: row.source_id,
    p_memo: d.memo,
    p_usage: { units: d.units, unit: d.unit, direction: row.direction },
    p_idem: d.idem,
  });
  // Not on the ledger as far as we know: retried with the same key (retryLater), never
  // dropped. If it did post (a lost reply), the retry replays it, or readLedger finds it.
  if (error) throw new Error(`wallet_usage_debit failed: ${error.message}`);
  const tx = (Array.isArray(data) ? data[0] : data) as {
    tx_id?: number | string | null; replayed?: boolean | null;
    amount_exact_micros?: number | string | null; cost_micros?: number | string | null;
  } | null;
  run.charged.add(row.client_id);
  if (tx?.replayed === true && tx.tx_id !== null && tx.tx_id !== undefined) {
    // An earlier attempt posted it: record the ORIGINAL line's charge and cost, not ours.
    const line = ledgerLine({ id: tx.tx_id, amount_exact_micros: tx.amount_exact_micros ?? null, cost_micros: tx.cost_micros ?? null });
    if (line) return settleFromLedger(run, row, line, "charged", d, would);
  }
  await updateRow(run, row, { ...base, state: "charged", charge_micros: would, markup: s.markup, wallet_tx_id: tx?.tx_id ?? null });
  return "charged";
}

/**
 * Settle a row from a line already on the ledger (THE LEDGER WINS, in the header). The money
 * columns (wallet_tx_id, charge_micros, cost_micros) are the line's. The description (units,
 * memo, the leg breakdown) is this attempt's when there is one, else the line's own. markup is
 * today's only when it reproduces the line's charge: the line does not record the markup it
 * was made with. When this attempt's figures differ, cost_detail.ledger keeps them beside the
 * line's, and cost_source (how THIS attempt priced it) is left empty. `instead` is what this
 * attempt would have settled the row as; anything but charged is logged, since the operator
 * may want to refund it.
 */
async function settleFromLedger(
  run: Run, row: ChargeRow, line: LedgerLine, instead: FinalState, d: Decision | null, would: number | null,
): Promise<"charged"> {
  const s = run.settings;
  const cost = line.costMicros ?? d?.costMicros ?? null;
  const units = d ? d.units : line.units;
  const ceiling = d ? d.ceilingMicros : ceilingFor(row.source, s);
  const markup = s.markup !== null && cost !== null && units !== null && chargeFor(cost, s.markup, ceiling, units) === line.chargeMicros
    ? s.markup
    : null;
  const patch: Record<string, unknown> = {
    state: "charged", wallet_tx_id: line.txId, charge_micros: line.chargeMicros, cost_micros: cost, markup, last_error: null,
  };
  if (d) {
    const same = cost === d.costMicros && line.chargeMicros === would;
    Object.assign(patch, {
      units: d.units, unit: d.unit, memo: d.memo,
      cost_source: cost === d.costMicros ? d.costSource : null,
      cost_detail: same ? d.costDetail : {
        ...d.costDetail,
        ledger: { wallet_tx_id: line.txId, recomputed_cost_micros: d.costMicros, recomputed_charge_micros: would },
      },
    });
  } else {
    Object.assign(patch, {
      units: line.units, unit: line.unit ?? (row.source === "sms" ? "segment" : "minute"), memo: line.memo,
      cost_detail: { ledger: { wallet_tx_id: line.txId } },
    });
  }
  await updateRow(run, row, patch);
  if (instead !== "charged") {
    await logFault({
      code: "usage_charge_kept_from_ledger", severity: "warn", clientId: row.client_id,
      message: `Usage charge ${row.source} ${row.source_id} was already on the ledger (transaction ${line.txId}, ${line.chargeMicros} micros) from an earlier attempt that did not finish (a lost reply, a failed row update or a run cut off). Recorded as charged, though this run would have settled it as ${instead}. Check whether it should be refunded.`,
      context: { id: row.id, wallet_tx_id: line.txId, instead },
    });
  }
  return "charged";
}

// ── Calls ───────────────────────────────────────────────────────────────────────────

async function chargeCall(run: Run, row: ChargeRow, call: UsageCall | null, events: UsageEvent[]): Promise<FinalState | "pending"> {
  if (!call) {
    const line = run.ledger.get(row.id);
    if (line) return settleFromLedger(run, row, line, "failed", null, null);
    await updateRow(run, row, { state: "failed", last_error: "the call row is gone" });
    await logFault({ code: "usage_charge_source_gone", clientId: row.client_id, message: `phone_calls ${row.source_id} is gone; its usage charge was given up.` });
    return "failed";
  }
  const ended = Date.parse(call.ended_at ?? "");
  if (!FINAL_CALL.has(call.status) || !Number.isFinite(ended)) {
    return reschedule(run, row, run.now.getTime() + 5 * 60_000, "the call has not finished");
  }
  // A missed call becomes a voicemail when the recording lands; let the row settle first, and
  // a missed one for a whole sweep (MISSED_SETTLE_MS).
  const settle = call.status === "missed" ? MISSED_SETTLE_MS : SETTLE_MS;
  if (run.now.getTime() - ended < settle) return reschedule(run, row, ended + settle, null);

  const vm = one(call.phone_voicemails);
  const bill = callBillability(call, vm?.duration_s ?? null, run.settings);
  const allowEstimate = run.now.getTime() - ended >= run.settings.fallbackAfterHours * 3_600_000;
  const priced = await callCost(run, call, vm, events, allowEstimate);
  if ("pending" in priced) return reschedule(run, row, backoffAt(run, row), priced.pending);

  const state = await decide(run, row, {
    ...priced,
    billable: bill.billable,
    units: bill.units,
    unit: "minute",
    meter: meterFor("call", call.direction),
    refType: "phone_call",
    idem: idemFor(row),
    memo: callMemo(call, bill.units),
    ceilingMicros: run.settings.ceilingMinMicros,
  });
  const cents = Math.round(priced.costMicros / 10_000);
  if (cents !== call.cost_cents) {
    run.budget.spendTail();
    await patchCall(run.admin, call.id, { cost_cents: cents });
  }
  return state;
}

type LegKind = "client" | "pstn_in" | "pstn_out";

function legKind(leg: TwilioLegCost): LegKind {
  if (leg.from.startsWith("client:") || leg.to.startsWith("client:")) return "client";
  return leg.direction === "inbound" ? "pstn_in" : "pstn_out";
}

/**
 * Whether a leg could have dialed anyone. An app being rung (outbound-dial to client:) and a
 * leg the REST API created (a warm-transfer teammate, a handoff) never run a <Dial>; asking
 * for their children would only spend a request.
 */
function mayHaveChildren(leg: TwilioLegCost): boolean {
  if (leg.direction === "outbound-api") return false;
  if (leg.direction.startsWith("outbound") && leg.to.startsWith("client:")) return false;
  return true;
}

/**
 * Every leg of the call, deduplicated: the row's, the events', their children, and their
 * parents. Parents matter after a cold transfer of an OUTBOUND call: the teammate's answer
 * overwrites client_call_sid, and the original app leg (the customer leg's parent) is then on
 * no row and in no event, so it is found by walking up from the customer's leg.
 */
async function collectLegs(run: Run, call: UsageCall, events: UsageEvent[]): Promise<{ legs: TwilioLegCost[]; truncated: boolean }> {
  const legs = new Map<string, TwilioLegCost>();
  let truncated = false;
  const explore = async (leg: TwilioLegCost, depth: number): Promise<void> => {
    if (depth >= MAX_DEPTH || !mayHaveChildren(leg)) return;
    if (legs.size >= MAX_LEGS) { truncated = true; return; }
    run.budget.spend();
    for (const child of await listChildCalls(run.env, leg.sid)) {
      if (legs.has(child.sid)) continue;
      if (legs.size >= MAX_LEGS) { truncated = true; return; }
      legs.set(child.sid, child);
      await explore(child, depth + 1);
    }
  };
  // The parent first, so its children (most event SIDs among them) cost no fetch of their own.
  const rowSids = call.direction === "out" ? [call.client_call_sid, call.twilio_call_sid] : [call.twilio_call_sid, call.client_call_sid];
  const eventSids = events
    .filter((e) => e.data?.source !== "app")
    .map((e) => e.data?.sid);
  const queue: unknown[] = [...rowSids, ...eventSids];
  const missing = new Set<string>();
  for (let i = 0; i < queue.length; i++) {
    const sid = queue[i];
    if (typeof sid !== "string" || !CALL_SID_RE.test(sid) || legs.has(sid) || missing.has(sid)) continue;
    if (legs.size >= MAX_LEGS) { truncated = true; break; }
    run.budget.spend();
    const leg = await fetchCallCost(run.env, sid);
    if (!leg) { missing.add(sid); continue; }
    legs.set(leg.sid || sid, leg);
    await explore(leg, 0);
    // Up as well as down (bounded by MAX_LEGS like everything else here).
    if (leg.parentCallSid && !legs.has(leg.parentCallSid)) queue.push(leg.parentCallSid);
  }
  return { legs: [...legs.values()], truncated };
}

function fallbackRate(kind: LegKind, s: BillingSettings): number {
  if (kind === "client") return s.fallbackClientMinMicros;
  return kind === "pstn_in" ? s.fallbackInMinMicros : s.fallbackOutMinMicros;
}

/** The whole call at the fallback rates, when Twilio could not be asked at all. */
function estimateFromRow(call: UsageCall, vm: VmJoin | null, s: BillingSettings, why: string): Priced {
  const minutes = Math.ceil((Number(call.duration_s) || 0) / 60);
  const pstn = call.direction === "out" ? s.fallbackOutMinMicros : s.fallbackInMinMicros;
  const vmMinutes = vm?.recording_sid ? Math.max(1, Math.ceil((Number(vm.duration_s) || 0) / 60)) : 0;
  const micros = minutes * (pstn + s.fallbackClientMinMicros) + vmMinutes * (s.fallbackInMinMicros + RECORDING_MIN_MICROS);
  return { costMicros: micros, costSource: "estimate", costDetail: { fallback: why.slice(0, 200), minutes, voicemail_minutes: vmMinutes } };
}

async function callCost(run: Run, call: UsageCall, vm: VmJoin | null, events: UsageEvent[], allowEstimate: boolean): Promise<Priced | { pending: string }> {
  const s = run.settings;
  if (!twilioConfigured(run.env)) {
    return allowEstimate ? estimateFromRow(call, vm, s, "Twilio is not configured") : { pending: "Twilio is not configured" };
  }
  let collected: { legs: TwilioLegCost[]; truncated: boolean };
  try {
    collected = await collectLegs(run, call, events);
  } catch (e) {
    if (e instanceof BudgetSpent) throw e;
    const why = (e as Error)?.message ?? String(e);
    return allowEstimate ? estimateFromRow(call, vm, s, why) : { pending: why };
  }

  let micros = 0;
  let estimated = false;
  const legParts: Record<string, unknown>[] = [];
  for (const leg of collected.legs) {
    const kind = legKind(leg);
    const part: Record<string, unknown> = { sid: leg.sid, kind, status: leg.status, duration_s: leg.duration, price_micros: leg.price };
    if (leg.priceUnit && leg.priceUnit !== "USD") part.price_unit = leg.priceUnit;
    legParts.push(part);
    if (leg.price !== null) { micros += leg.price; continue; }
    const connected = leg.status === "completed" && (leg.duration ?? 0) > 0;
    // Never connected (busy, no answer, canceled, failed): Twilio bills nothing for it.
    if (!LIVE_LEG.has(leg.status) && !connected) { part.price_micros = 0; continue; }
    if (!allowEstimate) return { pending: `leg ${leg.sid} is not priced yet` };
    const est = Math.max(1, Math.ceil((leg.duration ?? (Number(call.duration_s) || 0)) / 60)) * fallbackRate(kind, s);
    part.price_micros = est;
    part.estimated = true;
    micros += est;
    estimated = true;
  }
  const detail: Record<string, unknown> = { legs: legParts };
  if (collected.truncated) detail.truncated = true;

  if (vm?.recording_sid) {
    let rec: Awaited<ReturnType<typeof fetchRecording>> = null;
    let recErr: string | null = null;
    try {
      run.budget.spend();
      rec = await fetchRecording(run.env, vm.recording_sid);
    } catch (e) {
      if (e instanceof BudgetSpent) throw e;
      recErr = (e as Error)?.message ?? String(e);
    }
    const recMinutes = Math.max(1, Math.ceil((rec?.duration ?? (Number(vm.duration_s) || 0)) / 60));
    if (rec && rec.price !== null) {
      micros += rec.price;
      detail.recording = { sid: rec.sid, duration_s: rec.duration, price_micros: rec.price };
    } else if (rec === null && recErr === null) {
      detail.recording = { sid: vm.recording_sid, gone: true, price_micros: 0 };
    } else if (!allowEstimate) {
      return { pending: recErr ?? "the voicemail recording is not priced yet" };
    } else {
      const est = recMinutes * RECORDING_MIN_MICROS;
      micros += est;
      estimated = true;
      detail.recording = { sid: vm.recording_sid, duration_s: rec?.duration ?? vm.duration_s, price_micros: est, estimated: true };
    }
  }

  // Conference minutes are billed apart from the legs, and no leg resource shows them. The row
  // rarely says so by now (/voice/status clears transfer_state when the customer's leg ends), so
  // the Worker's own events do: hold, warm transfer, Twilio's start, and a finished device switch.
  const hadConference = call.transfer_state === "conference"
    || events.some((e) => e.data?.source !== "app" && (CONFERENCE_EVENTS.has(e.type) || movedIntoConference(e)));
  let conference = false;
  if (hadConference) {
    const joined = collected.legs.filter((l) => (l.duration ?? 0) > 0);
    const confMicros = joined.reduce((sum, l) => sum + Math.ceil((l.duration ?? 0) / 60) * CONFERENCE_MIN_MICROS, 0);
    micros += confMicros;
    conference = true;
    detail.conference = { participant_legs: joined.length, micros: confMicros, estimated: true };
  }
  return { costMicros: micros, costSource: estimated ? "estimate" : conference ? "mixed" : "twilio", costDetail: detail };
}

// ── Call recordings and their transcripts (migration 263) ───────────────────────────

/** The row is gone (the call was deleted with it): the ledger's word, else failed. */
async function sourceGone(run: Run, row: ChargeRow, what: string): Promise<FinalState> {
  const line = run.ledger.get(row.id);
  if (line) return settleFromLedger(run, row, line, "failed", null, null);
  await updateRow(run, row, { state: "failed", last_error: `the ${what} row is gone` });
  await logFault({ code: "usage_charge_source_gone", clientId: row.client_id, message: `phone_call_recordings ${row.source_id} is gone; its ${row.source} charge was given up.` });
  return "failed";
}

/** Whole minutes, rounded up, at least one: how Twilio bills a recording. */
const recMinutes = (s: number | null | undefined): number => Math.max(1, Math.ceil((Number(s) || 0) / 60));

/**
 * A call recording: Twilio's own price for it (fetchRecording), which it fills in a while after
 * the recording ends. Unpriced until fallback_after_hours: pending. After that, or when Twilio no
 * longer has it (retention, or deleted by hand before it was priced), RECORDING_MIN_MICROS a
 * minute, an estimate. Storage is not metered.
 */
async function chargeRecording(run: Run, row: ChargeRow, rec: UsageRecording | null): Promise<FinalState | "pending"> {
  if (!rec) return sourceGone(run, row, "recording");
  const ended = Date.parse(rec.completed_at ?? "");
  if (!Number.isFinite(ended)) return reschedule(run, row, backoffAt(run, row), "the recording has not completed");
  if (run.now.getTime() - ended < SETTLE_MS) return reschedule(run, row, ended + SETTLE_MS, null);
  const allowEstimate = run.now.getTime() - ended >= run.settings.fallbackAfterHours * 3_600_000;
  const units = recMinutes(rec.duration_s);
  const billable = rec.status === "completed" && (Number(rec.duration_s) || 0) > 0;

  let priced: Priced;
  let tw: Awaited<ReturnType<typeof fetchRecording>> = null;
  let twErr: string | null = null;
  if (rec.recording_sid && twilioConfigured(run.env)) {
    try {
      run.budget.spend();
      tw = await fetchRecording(run.env, rec.recording_sid);
    } catch (e) {
      if (e instanceof BudgetSpent) throw e;
      twErr = (e as Error)?.message ?? String(e);
    }
  } else {
    twErr = rec.recording_sid ? "Twilio is not configured" : "the recording has no SID";
  }
  if (tw && tw.price !== null) {
    priced = { costMicros: tw.price, costSource: "twilio", costDetail: { sid: tw.sid, duration_s: tw.duration, price_micros: tw.price } };
  } else if (!billable) {
    priced = { costMicros: 0, costSource: "twilio", costDetail: { sid: rec.recording_sid, status: rec.status, price_micros: 0 } };
  } else if (tw === null && twErr === null && rec.deleted_at) {
    // Deleted before Twilio priced it: what it would have cost, an estimate.
    priced = { costMicros: units * RECORDING_MIN_MICROS, costSource: "estimate", costDetail: { sid: rec.recording_sid, gone: true, minutes: units } };
  } else if (!allowEstimate) {
    return reschedule(run, row, backoffAt(run, row), twErr ?? "the recording is not priced yet");
  } else {
    priced = {
      costMicros: units * RECORDING_MIN_MICROS, costSource: "estimate",
      costDetail: { sid: rec.recording_sid, minutes: units, fallback: (twErr ?? "not priced in time").slice(0, 200) },
    };
  }
  return decide(run, row, {
    ...priced,
    billable,
    units,
    unit: "minute",
    meter: meterFor("recording", row.direction),
    refType: "phone_call_recording",
    idem: idemFor(row),
    memo: recordingMemo("recording", one(rec.phone_calls), units),
    ceilingMicros: null,
  });
}

/**
 * A recording's transcript and summary, one line: what the transcript (Workers AI) and the
 * summary (Claude) cost, both estimates written where they were made. Billable once there was
 * something to transcribe; a summary that failed adds nothing.
 */
async function chargeTranscription(run: Run, row: ChargeRow, rec: UsageRecording | null): Promise<FinalState | "pending"> {
  if (!rec) return sourceGone(run, row, "recording");
  if (rec.transcript_status !== "done" || !["done", "failed", "off"].includes(rec.summary_status)) {
    return reschedule(run, row, backoffAt(run, row), "the transcript or summary is not finished");
  }
  const micros = (v: unknown): number => {
    const n = v === null || v === undefined || v === "" ? NaN : Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
  };
  const stt = micros(rec.stt_cost_micros);
  const llm = micros(rec.llm_cost_micros);
  const units = recMinutes(rec.duration_s);
  return decide(run, row, {
    costMicros: stt + llm,
    costSource: "estimate",
    costDetail: { stt_micros: stt, llm_micros: llm, summary: rec.summary_status },
    billable: stt + llm > 0,
    units,
    unit: "minute",
    meter: meterFor("transcription", row.direction),
    refType: "phone_call_recording",
    idem: idemFor(row),
    memo: recordingMemo("transcription", one(rec.phone_calls), units),
    ceilingMicros: null,
  });
}

// ── Texts ───────────────────────────────────────────────────────────────────────────

async function chargeSms(run: Run, row: ChargeRow, msg: UsageSms | null): Promise<FinalState | "pending"> {
  if (!msg) {
    const line = run.ledger.get(row.id);
    if (line) return settleFromLedger(run, row, line, "failed", null, null);
    await updateRow(run, row, { state: "failed", last_error: "the text row is gone" });
    await logFault({ code: "usage_charge_source_gone", clientId: row.client_id, message: `sms_messages ${row.source_id} is gone; its usage charge was given up.` });
    return "failed";
  }
  const s = run.settings;
  const created = Date.parse(msg.created_at);
  const age = Number.isFinite(created) ? run.now.getTime() - created : Number.POSITIVE_INFINITY;
  if (age < SETTLE_MS) return reschedule(run, row, created + SETTLE_MS, null);
  const allowEstimate = age >= s.fallbackAfterHours * 3_600_000;
  const direction: "in" | "out" = msg.direction === "in" ? "in" : "out";

  let tw: Awaited<ReturnType<typeof fetchMessage>> = null;
  let twErr: string | null = null;
  if (!msg.provider_sid) twErr = "the text has no Twilio SID";
  else if (!twilioConfigured(run.env)) twErr = "Twilio is not configured";
  else {
    try {
      run.budget.spend();
      tw = await fetchMessage(run.env, msg.provider_sid);
    } catch (e) {
      if (e instanceof BudgetSpent) throw e;
      twErr = (e as Error)?.message ?? String(e);
    }
  }
  // Twilio's status is the fresher one (a delivery receipt may not have reached our row yet).
  if (tw && LIVE_SMS.has(tw.status) && !allowEstimate) return reschedule(run, row, backoffAt(run, row), "the text is still being sent");
  const status = tw && !LIVE_SMS.has(tw.status) ? tw.status : msg.status;
  const billable = smsBillable(direction, status);
  const segments = Math.max(1, Number(tw?.numSegments ?? msg.num_segments ?? 1) || 1);

  let micros: number;
  let source: Priced["costSource"] = "twilio";
  const detail: Record<string, unknown> = { sid: msg.provider_sid, status, segments, price_micros: tw?.price ?? null };
  if (tw?.priceUnit && tw.priceUnit !== "USD") detail.price_unit = tw.priceUnit;
  if (tw && tw.price !== null) micros = tw.price;
  else if (!billable) micros = 0; // a text that failed was never priced, and cost nothing
  else if (!allowEstimate) return reschedule(run, row, backoffAt(run, row), twErr ?? "the text is not priced yet");
  else {
    // A photo text received is one MMS message at Twilio, priced per message, not per segment.
    const mms = direction === "in" && Number(msg.num_media) > 0;
    micros = mms ? MMS_IN_MICROS : segments * s.fallbackSmsSegMicros;
    source = "estimate";
    detail.fallback = (twErr ?? "not priced in time").slice(0, 200);
    detail.price_micros = micros;
    if (mms) detail.mms = true;
  }
  // Carrier fees are billed apart and never appear on the message: a standing estimate.
  const carrier = billable ? segments * (direction === "out" ? s.carrierFeeOutMicros : s.carrierFeeInMicros) : 0;
  detail.carrier_fee_micros = carrier;
  micros += carrier;

  return decide(run, row, {
    costMicros: micros,
    costSource: source,
    costDetail: detail,
    billable,
    units: segments,
    unit: "segment",
    meter: meterFor("sms", direction),
    refType: "sms_message",
    idem: idemFor(row),
    memo: smsMemo(direction, direction === "out" ? msg.to_number : msg.from_number, segments),
    ceilingMicros: s.ceilingSegMicros,
  });
}

// ── Auto top-up ─────────────────────────────────────────────────────────────────────

/**
 * One request per tenant a line was posted for this run, when auto top-up is on and what it
 * can spend (balance − held, autoTopupDecision's measure) is now under its threshold. The
 * edge function re-reads the wallet and applies its own cooldown, so a tenant that stays under
 * the threshold across runs is asked again without being charged again. Awaited (each with a
 * 35 s timeout) so the run's waitUntil covers them; a failure is logged, never thrown.
 */
async function autoTopUps(run: Run): Promise<number> {
  const ids = [...run.charged];
  if (!ids.length) return 0;
  run.budget.spendTail();
  const rows = (must(
    await run.admin.from("wallet_accounts")
      .select("client_id, balance_cents, held_cents, auto_topup_enabled, auto_topup_threshold_cents").in("client_id", ids),
    "read auto top-up settings",
  ) as { client_id: string; balance_cents?: number | string; held_cents?: number | string; auto_topup_enabled?: boolean; auto_topup_threshold_cents?: number | string | null }[] | null) ?? [];
  const due = rows.filter((r) => {
    const threshold = Number(r.auto_topup_threshold_cents);
    const available = (Number(r.balance_cents) || 0) - (Number(r.held_cents) || 0);
    return r.auto_topup_enabled === true && Number.isFinite(threshold) && threshold > 0 && available < threshold;
  });
  run.budget.spendTail(due.length);
  await Promise.all(due.map((r) => requestAutoTopup(run.env, r.client_id)));
  return due.length;
}

// ── Twilio's own daily totals (09:00 UTC) ───────────────────────────────────────────

export type UsageSnapshotSummary =
  | { ran: false; reason: "switched_off" | "not_configured" }
  | { ran: true; day: string; rows: number };

/**
 * Yesterday's Usage Records into twilio_usage_daily (upsert on day + category, so a rerun
 * refreshes the day). What the account was really billed, to check the per-item costs and the
 * carrier-fee estimate against. Runs with cost capture, like the shadow rows.
 */
export async function snapshotTwilioUsage(env: Env, admin: Admin, now = new Date()): Promise<UsageSnapshotSummary> {
  if (env.PHONE_USAGE_METERS !== "on" && env.PHONE_USAGE_COST_CAPTURE === "off") return { ran: false, reason: "switched_off" };
  if (!twilioConfigured(env)) return { ran: false, reason: "not_configured" };
  const day = previousUtcDay(now);
  const records = await listUsageDaily(env, day);
  if (records.length) {
    const fetchedAt = now.toISOString();
    must(
      await admin.from("twilio_usage_daily").upsert(records.map((r) => ({
        day, category: r.category, count: r.count, usage: r.usage, price_micros: r.priceMicros, fetched_at: fetchedAt,
      })), { onConflict: "day,category" }),
      "upsert twilio_usage_daily",
    );
  }
  return { ran: true, day, rows: records.length };
}
