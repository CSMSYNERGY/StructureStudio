// Call recording (release B2): one dual-channel recording per call, on the CUSTOMER's leg,
// announced first and started through Twilio's REST API when someone answers.
//
// ── WHY THE CUSTOMER'S LEG, AND WHY REST ───────────────────────────────────────────────────
// The customer's leg (phone_calls.twilio_call_sid) is the one leg that lasts through hold, warm
// and cold transfer and a device switch (conference.ts THE MOVE), so a recording on it covers
// the whole call, once. Dual channel keeps the customer on one channel and everyone else on the
// other (CHANNEL_MAP), which is how the transcript says who spoke without guessing. Starting it
// through REST, never with a TwiML `record` attribute, is what lets the Worker decide per call.
//
// ── OFF AT THREE LEVELS ────────────────────────────────────────────────────────────────────
//   1. env CALL_RECORDING must be exactly "on" (recordingEnvOn);
//   2. the business's switch is on (client_settings.phone_record_calls: on by default since
//      migration 287, and only the owner turns it off), with the announcement on (it is locked
//      on; RecordingSettings.notice);
//   3. the call is ARMED (phone_calls.recording_armed): written true by /voice/inbound and
//      /voice/outbound only when the TwiML they answered with carried the announcement. Never for
//      an emergency call, the 911 callback window, or a voicemail-only answer. Recording can only
//      ever START on an armed call, so a setting switched on mid-call cannot record a call that
//      never heard the notice.
// Pausing, resuming and stopping do not ask the env rail: a recording already running is still
// paused on hold and stopped before voicemail after the rail is switched off.
//
// ── THE LIFE OF ONE RECORDING (phone_call_recordings, migration 263) ───────────────────────
//   answer      startCallRecording claims the row (insert ... on conflict do nothing: two answer
//               callbacks, or a cold-transfer teammate answering, never start a second one) and
//               asks Twilio to record. A refusal (4xx) marks the row failed and is logged; the call
//               goes on unrecorded, and the next answer on it (a transfer) tries again. An answer
//               that was lost or broken (unreachable, 5xx, no SID) may mean Twilio IS recording,
//               so the row stays starting: Twilio's own callbacks bind the SID, or the backstop
//               settles it from Twilio's list, and no second recording is ever started.
//   hold        pauseCallRecording (PauseBehavior skip), so hold music stays out of the audio and
//               the transcript; resumeCallRecording when the customer is back with someone
//               (Resume, a hand-over in the conference, a cold-transfer teammate answering).
//   voicemail   stopCallRecording BEFORE the customer is redirected to the greeting, so their
//               message never lands in the call recording (it is a voicemail of its own).
//   end         Twilio's completed callback (/voice/recording) marks it completed and, when the
//               business transcribes and the rail is on, queues the transcript (cron/transcribe.ts).
//               The sweep's backstop (every 15 minutes) completes one whose callback was lost.
//
// ⚠️ NEVER LOGGED: a transcript, a summary, or anything a caller said. Faults carry codes, ids and
// Twilio's numeric error only (twilioRest.ts never propagates a Twilio message either).

import type { Ctx, Env } from "./env";
import {
  addCallEvent, adminClient, callById, must, type Admin, type CallRow, type RecordingSettings,
} from "./db";
import { UUID_RE } from "./http";
import { logFault } from "./log";
import type { TwilioParams } from "./twilioSignature";
import {
  fetchRecording, listCallRecordings, startRecording, TwilioError, twilioConfigured, updateRecording,
  type StartedRecording, type TwilioRecording,
} from "./twilioRest";
import { response, say } from "./twiml";
import { hook } from "./urls";
import { noticeSaysRecorded } from "../../../supabase/functions/_shared/recordingNotice.ts";

// ── The switches ────────────────────────────────────────────────────────────────────────

/** env CALL_RECORDING, exactly "on". */
export function recordingEnvOn(env: Env): boolean {
  return env.CALL_RECORDING === "on";
}

/** env CALL_TRANSCRIBE, exactly "on". */
export function callTranscribeOn(env: Env): boolean {
  return env.CALL_TRANSCRIBE === "on";
}

/**
 * May a call to or from this business be announced and recorded? The rail, the business's
 * switch and its announcement (locked on), and never an emergency call or the 911 callback
 * window. This is what phone_calls.recording_armed records.
 */
export function armedFor(env: Env, s: RecordingSettings, emergency = false): boolean {
  return recordingEnvOn(env) && s.on && s.notice && !emergency;
}

// ── The announcement ────────────────────────────────────────────────────────────────────

// Carolyn's wording (2026-10-06, migration 287). Word for word portal-settings/phone.ts and the
// portal's Settings card, which only show it (tests/phone/callRecordingUi_test.ts pins all three).
export const STANDARD_NOTICE = "This call may be recorded.";
export const STANDARD_NOTICE_TRANSCRIBED = "This call may be recorded and transcribed.";

/**
 * What the announcement says: the business's own sentence, else the standard one, which
 * mentions transcription only while it will really happen (the business left transcripts on
 * and the CALL_TRANSCRIBE rail is on). A stored sentence that doesn't say the call is recorded,
 * or denies it ("not recorded"), is never spoken: the standard one plays (portal-settings refuses
 * to save one; this covers a row written any other way).
 */
export function noticeText(env: Env, s: Pick<RecordingSettings, "notice_text" | "transcribe">): string {
  if (s.notice_text && s.notice_text.trim() && noticeSaysRecorded(s.notice_text)) return s.notice_text.trim();
  return s.transcribe && callTranscribeOn(env) ? STANDARD_NOTICE_TRANSCRIBED : STANDARD_NOTICE;
}

/**
 * The custom parameter every <Client> on an armed call carries, so the app can show "Recorded
 * call" while it rings (and a teammate rung by a transfer knows too).
 */
export function recordedParams(armed: boolean): Record<string, string> {
  return armed ? { recorded: "1" } : {};
}

/**
 * Which channel is whom. A REST recording of one leg with RecordingTrack "both" puts what Twilio
 * RECEIVES from that leg (the customer, whose leg it is) on the first channel and what it SENDS
 * them (everyone on our side) on the second. ⚠️ To be confirmed on the first test call (plan
 * section 13, step 8); each row keeps the map it was made with, so a correction here never
 * relabels an old transcript.
 */
export const CHANNEL_MAP: Readonly<Record<string, "customer" | "team">> = Object.freeze({ "0": "customer", "1": "team" });

// ── Rows ────────────────────────────────────────────────────────────────────────────────

export type RecordingStatus = "starting" | "recording" | "paused" | "completed" | "failed" | "absent";

export interface RecordingRow {
  id: string;
  call_id: string;
  client_id: string;
  recording_sid: string | null;
  status: RecordingStatus;
}

const REC_COLUMNS = "id, call_id, client_id, recording_sid, status";
const REC_SID_RE = /^RE[0-9a-f]{32}$/i;
/** A recording this short is a hang-up as it was answered: kept and playable, never transcribed. */
export const MIN_TRANSCRIBE_SECONDS = 5;

type RecCall = Pick<CallRow, "id" | "client_id" | "twilio_call_sid" | "is_emergency"> & { recording_armed?: boolean };

/** The call's recording row, or null. Throws on a database failure (callers catch). */
async function recordingOf(admin: Admin, callId: string): Promise<RecordingRow | null> {
  return must(
    await admin.from("phone_call_recordings").select(REC_COLUMNS).eq("call_id", callId).maybeSingle(),
    "read call recording",
  ) as RecordingRow | null;
}

/**
 * Whether a failed start may still have started a recording at Twilio: no answer at all (the
 * POST may have landed before the connection broke), a 5xx, or a 2xx without a SID. A 4xx is
 * Twilio refusing, so nothing was started.
 */
export function startMayHaveLanded(e: unknown): boolean {
  if (!(e instanceof TwilioError)) return true;
  return e.status === 0 || e.status >= 500 || (e.status >= 200 && e.status < 300);
}

/** A fault's summary: the Twilio code and status, or the first line of anything else. Never a transcript. */
function faultText(e: unknown): string {
  if (e instanceof TwilioError) return e.message;
  return String((e as Error)?.message ?? e).split("\n")[0].slice(0, 300);
}

// ── Start ───────────────────────────────────────────────────────────────────────────────

export type StartOutcome = "skipped" | "started" | "exists" | "resumed" | "failed";

/**
 * Claim the call's recording row: a new one, or a failed start retried (at most once per
 * answer: the update is conditional). Null when it is already started (or starting).
 */
async function claimStart(admin: Admin, call: RecCall, notice: string | null): Promise<{ id: string } | { existing: RecordingRow } | null> {
  const { data, error } = await admin.from("phone_call_recordings")
    .upsert({ call_id: call.id, client_id: call.client_id, status: "starting", notice_text: notice }, { onConflict: "call_id", ignoreDuplicates: true })
    .select("id");
  if (error) throw new Error(`claim failed: ${error.message}`);
  const id = (Array.isArray(data) ? (data[0] as { id?: string } | undefined)?.id : undefined) ?? null;
  if (id) return { id };
  const existing = await recordingOf(admin, call.id);
  if (!existing) return null;
  if (existing.status === "failed" && !existing.recording_sid) {
    const { data: again } = await admin.from("phone_call_recordings")
      .update({ status: "starting", last_error: null }).eq("id", existing.id).eq("status", "failed").is("recording_sid", null).select("id");
    if (Array.isArray(again) && again.length) return { id: existing.id };
  }
  return { existing };
}

/**
 * The sentence this business's announcement says now, kept on the recording row as what the
 * caller heard (the call's notice played moments before the answer). Null when it cannot be read:
 * the row is still made, and the call's recording_notice mark still says a notice played.
 */
async function noticeSnapshot(env: Env, admin: Admin, clientId: string): Promise<string | null> {
  const { data, error } = await admin.from("client_settings")
    .select("phone_recording_notice_text, phone_transcribe_calls").eq("client_id", clientId).maybeSingle();
  if (error) return null;
  const s = data as { phone_recording_notice_text?: string | null; phone_transcribe_calls?: boolean } | null;
  return noticeText(env, { notice_text: s?.phone_recording_notice_text ?? null, transcribe: s?.phone_transcribe_calls !== false });
}

/**
 * Someone answered an armed call: start its one recording, on the customer's leg. Called from
 * /voice/status (an app answering an inbound call or a transfer, the customer answering an
 * outbound one) and /voice/screen (a forwarded cell pressing 1), all after Twilio has its answer.
 * A recording that already exists and is paused (the customer was on hold) is resumed instead:
 * someone has them now. NEVER THROWS: the call goes on whatever happens here.
 */
export async function startCallRecording(env: Env, admin: Admin, call: RecCall): Promise<StartOutcome> {
  if (!recordingEnvOn(env) || call.recording_armed !== true || call.is_emergency || !call.twilio_call_sid) return "skipped";
  if (!twilioConfigured(env)) return "skipped";
  let id: string;
  try {
    const claimed = await claimStart(admin, call, await noticeSnapshot(env, admin, call.client_id));
    if (!claimed) return "exists";
    if ("existing" in claimed) {
      if (claimed.existing.status !== "paused") return "exists";
      return (await resumeCallRecording(env, admin, call)) === "resumed" ? "resumed" : "exists";
    }
    id = claimed.id;
  } catch (e) {
    await logFault({ code: "recording_start_failed", clientId: call.client_id, message: `Recording claim: ${faultText(e)}`, context: { callId: call.id } });
    return "failed";
  }

  let started: StartedRecording;
  try {
    started = await startRecording(env, call.twilio_call_sid, {
      RecordingChannels: "dual",
      RecordingTrack: "both",
      RecordingStatusCallback: hook(env, "/voice/recording", { rec: id }),
      RecordingStatusCallbackMethod: "POST",
      RecordingStatusCallbackEvent: ["in-progress", "completed", "absent"],
    });
  } catch (e) {
    const why = faultText(e);
    if (startMayHaveLanded(e)) {
      // Twilio may be recording already. Marking the row failed would orphan that audio (its
      // callbacks match only a starting row with no SID, and retention deletes by SID) and let the
      // next answer start a second one. So it stays starting: Twilio's in-progress / completed
      // callbacks (?rec=) bind the SID, or the backstop settles it from Twilio's list for the call
      // (completed, absent, or failed when Twilio has none an hour after the call ended).
      await admin.from("phone_call_recordings").update({ last_error: why.slice(0, 500) })
        .eq("id", id).eq("status", "starting");
      await logFault({
        code: "recording_start_failed", clientId: call.client_id,
        message: `Twilio's answer to the start was lost or broken; the row waits for Twilio's callback or the backstop: ${why}`,
        context: { callId: call.id, recording: id },
      });
      return "failed";
    }
    await admin.from("phone_call_recordings").update({ status: "failed", last_error: why.slice(0, 500) })
      .eq("id", id).eq("status", "starting");
    await logFault({ code: "recording_start_failed", clientId: call.client_id, message: `Twilio refused to record: ${why}`, context: { callId: call.id, recording: id } });
    await addCallEvent(admin, call.id, "recording_failed", null);
    return "failed";
  }

  // Twilio's in-progress callback may have landed first and set the row already: then only the
  // SID and start time are filled in, and its status is left alone.
  const filled = { recording_sid: started.sid, started_at: new Date().toISOString(), channels: started.channels ?? 2, channel_map: CHANNEL_MAP };
  const { data: moved, error } = await admin.from("phone_call_recordings").update({ ...filled, status: "recording" })
    .eq("id", id).eq("status", "starting").select("id");
  if (error) {
    await logFault({ code: "recording_row_update_failed", clientId: call.client_id, message: `phone_call_recordings update failed: ${error.message}`, context: { recording: id } });
  } else if (!Array.isArray(moved) || !moved.length) {
    await admin.from("phone_call_recordings").update(filled).eq("id", id).is("recording_sid", null);
  }
  await addCallEvent(admin, call.id, "recording_started", { channels: started.channels ?? null });
  return "started";
}

// ── Pause, resume, stop ─────────────────────────────────────────────────────────────────

export type ChangeOutcome = "none" | "paused" | "resumed" | "stopped" | "failed";

/**
 * One change to a running recording. "none" when the call is not armed, has no recording, or it
 * is not in the state the change applies to (a second Hold, a Resume of a call never paused).
 * Never throws.
 */
async function changeRecording(env: Env, admin: Admin, call: RecCall, change: "pause" | "resume" | "stop"): Promise<ChangeOutcome> {
  if (call.recording_armed !== true || !call.twilio_call_sid) return "none";
  try {
    const rec = await recordingOf(admin, call.id);
    if (!rec?.recording_sid) return "none";
    const from: RecordingStatus[] = change === "pause" ? ["recording"] : change === "resume" ? ["paused"] : ["recording", "paused"];
    if (!from.includes(rec.status)) return "none";
    const fields: Record<string, string> = change === "pause"
      ? { Status: "paused", PauseBehavior: "skip" }
      : change === "resume" ? { Status: "in-progress" } : { Status: "stopped" };
    try {
      await updateRecording(env, call.twilio_call_sid, rec.recording_sid, fields);
    } catch (e) {
      // 404: the recording (or the call) has already finished, which is what a stop wanted.
      if (e instanceof TwilioError && e.status === 404) return "none";
      throw e;
    }
    if (change !== "stop") {
      await admin.from("phone_call_recordings").update({ status: change === "pause" ? "paused" : "recording" })
        .eq("id", rec.id).eq("status", rec.status);
    }
    const outcome: ChangeOutcome = change === "pause" ? "paused" : change === "resume" ? "resumed" : "stopped";
    await addCallEvent(admin, call.id, `recording_${outcome}`, null);
    return outcome;
  } catch (e) {
    await logFault({
      code: `recording_${change}_failed`, clientId: call.client_id,
      message: `Recording ${change}: ${faultText(e)}`, context: { callId: call.id },
    });
    return "failed";
  }
}

/** The customer went on hold: hold music stays out of the recording (PauseBehavior skip). */
export function pauseCallRecording(env: Env, admin: Admin, call: RecCall): Promise<ChangeOutcome> {
  return changeRecording(env, admin, call, "pause");
}

/** The customer is back with someone: Resume, a hand-over, a teammate taking a cold transfer. */
export function resumeCallRecording(env: Env, admin: Admin, call: RecCall): Promise<ChangeOutcome> {
  return changeRecording(env, admin, call, "resume");
}

/**
 * The customer is about to be sent to voicemail mid-call (a customer left alone in the
 * conference, a transfer nobody took). AWAIT IT BEFORE THE REDIRECT, so the greeting and their
 * message stay out of the call recording. A cold transfer to a teammate on DND, whose redirect can
 * fail with the call still going, pauses first and stops only once the redirect has landed
 * (routes/calls.ts transfer): a stopped recording can't be resumed.
 */
export function stopCallRecording(env: Env, admin: Admin, call: RecCall): Promise<ChangeOutcome> {
  return changeRecording(env, admin, call, "stop");
}

// ── Completed (the callback, and the sweep's backstop) ──────────────────────────────────

/** Does this business want transcripts? Fails CLOSED (no transcript) on a read error. */
async function businessTranscribes(admin: Admin, clientId: string): Promise<boolean> {
  const { data, error } = await admin.from("client_settings").select("phone_transcribe_calls").eq("client_id", clientId).maybeSingle();
  if (error) {
    await logFault({ code: "recording_settings_read_failed", clientId, severity: "warn", message: `client_settings read failed: ${error.message}` });
    return false;
  }
  return (data as { phone_transcribe_calls?: boolean } | null)?.phone_transcribe_calls !== false;
}

/**
 * Twilio has the finished recording: completed, with its length, and the transcript queued when
 * it will be made (the rail, the business's choice, long enough to say anything). Conditional on
 * the row still being live, so a repeated callback (or the backstop meeting a late one) changes
 * nothing.
 */
export async function completeRecording(env: Env, admin: Admin, row: RecordingRow, sid: string, durationS: number | null): Promise<"completed" | "ignored"> {
  const duration = Number.isFinite(durationS ?? NaN) && (durationS as number) >= 0 ? Math.round(durationS as number) : null;
  const queue = callTranscribeOn(env) && (duration ?? 0) >= MIN_TRANSCRIBE_SECONDS && await businessTranscribes(admin, row.client_id);
  const now = new Date().toISOString();
  const { data, error } = await admin.from("phone_call_recordings").update({
    status: "completed", recording_sid: sid, duration_s: duration, completed_at: now,
    transcript_status: queue ? "pending" : "off", next_try_at: queue ? now : null,
  }).eq("id", row.id).in("status", ["starting", "recording", "paused"]).select("id");
  if (error) throw new Error(`phone_call_recordings completion failed: ${error.message}`);
  if (!Array.isArray(data) || !data.length) return "ignored";
  await addCallEvent(admin, row.call_id, "recording_completed", { duration });
  return "completed";
}

// ── /voice/recording (Twilio's recording status callback) ───────────────────────────────

export type CallbackOutcome = "recording" | "completed" | "absent" | "failed" | "ignored";

/**
 * RecordingStatusCallback for one row (?rec=<id>). Runs in waitUntil after the 204. Taken only
 * when it is about this row's recording: its stored SID, or (while the start is still in
 * flight) a RecordingSid on the row's own customer leg. The audio is only ever fetched later by
 * that SID from Twilio, never from a URL in this request. Accepted on ?key= alone (`signed`
 * false), Twilio's own record has to agree before anything is written: the recording exists, is
 * a call recording (StartCallRecordingAPI) and is of THIS call's customer leg (the account holds
 * every business's recordings, and an unsigned request's CallSid is only its word), and a
 * "completed" takes Twilio's length.
 */
export async function recordingCallback(env: Env, p: TwilioParams, url: URL, signed = true): Promise<CallbackOutcome> {
  const id = url.searchParams.get("rec") ?? "";
  const sid = String(p.RecordingSid ?? "");
  const status = String(p.RecordingStatus ?? "");
  if (!UUID_RE.test(id) || !REC_SID_RE.test(sid)) return "ignored";
  const admin = adminClient(env);
  const row = must(
    await admin.from("phone_call_recordings").select(`${REC_COLUMNS}, phone_calls(twilio_call_sid)`).eq("id", id).maybeSingle(),
    "read call recording",
  ) as (RecordingRow & { phone_calls?: { twilio_call_sid: string | null } | { twilio_call_sid: string | null }[] | null }) | null;
  if (!row) return "ignored";
  const callRow = Array.isArray(row.phone_calls) ? row.phone_calls[0] : row.phone_calls;
  const ours = row.recording_sid
    ? sid === row.recording_sid
    : row.status === "starting" && !!callRow?.twilio_call_sid && String(p.CallSid ?? "") === callRow.twilio_call_sid;
  if (!ours) {
    await logFault({
      code: "recording_callback_mismatch", severity: "warn", throttleMs: 10 * 60_000,
      message: "A recording callback named a recording that is not this row's; it was ignored.", context: { recording: id },
    });
    return "ignored";
  }
  /** Unsigned: Twilio's record of the recording, only when it is a call recording of this row's customer leg. */
  const twilioAgrees = async () => {
    const tw = await fetchRecording(env, sid);
    if (tw && tw.source === "StartCallRecordingAPI" && !!callRow?.twilio_call_sid && tw.callSid === callRow.twilio_call_sid) return tw;
    await logFault({
      code: "recording_callback_unverified", severity: "warn", throttleMs: 10 * 60_000,
      message: "An unsigned recording callback named a recording Twilio does not show as this call's; it was ignored.", context: { recording: id },
    });
    return null;
  };

  if (status === "in-progress") {
    if (row.status !== "starting") return "ignored";
    if (!signed && !(await twilioAgrees())) return "ignored";
    const t = p.RecordingStartTime ? Date.parse(p.RecordingStartTime) : NaN;
    await admin.from("phone_call_recordings").update({
      status: "recording", recording_sid: sid, started_at: new Date(Number.isFinite(t) ? t : Date.now()).toISOString(),
    }).eq("id", row.id).eq("status", "starting");
    return "recording";
  }
  if (status === "completed") {
    let duration = Number.parseInt(String(p.RecordingDuration ?? ""), 10);
    if (!signed) {
      const tw = await twilioAgrees();
      if (!tw) return "ignored";
      duration = tw.duration ?? duration;
    }
    return completeRecording(env, admin, row, sid, Number.isFinite(duration) ? duration : null);
  }
  if (status === "absent" || status === "failed") {
    // absent: Twilio heard no audio at all. Nothing to play or transcribe; the row says so.
    // Unsigned, a row with no SID yet takes one only when Twilio agrees (the backstop settles it otherwise).
    if (!signed && !row.recording_sid && !(await twilioAgrees())) return "ignored";
    const { data } = await admin.from("phone_call_recordings").update({
      status, recording_sid: sid, completed_at: new Date().toISOString(),
    }).eq("id", row.id).in("status", ["starting", "recording", "paused"]).select("id");
    if (Array.isArray(data) && data.length) await addCallEvent(admin, row.call_id, `recording_${status}`, null);
    return status;
  }
  return "ignored";
}

// ── /voice/notice (the outbound announcement) ───────────────────────────────────────────

/**
 * The whisper an armed OUTBOUND call's <Number url> runs: the customer hears it after they pick
 * up and before the two sides are bridged, so it lands inside the recording, which starts on the
 * same answer. ?call is the phone_calls id and ?c the business, for its wording; a read that
 * fails still announces, in the standard words (the call IS armed, or this URL would not be on
 * it). Always valid TwiML: an error here would cost the customer the call.
 */
export async function noticeTwiml(env: Env, ec: Ctx, url: URL): Promise<string> {
  const callId = url.searchParams.get("call") ?? "";
  const clientId = (url.searchParams.get("c") ?? "").slice(0, 100);
  let text = STANDARD_NOTICE;
  if (clientId) {
    try {
      const admin = adminClient(env);
      const { data, error } = await admin.from("client_settings")
        .select("phone_recording_notice_text, phone_transcribe_calls").eq("client_id", clientId).maybeSingle();
      if (error) throw new Error(error.message);
      const s = data as { phone_recording_notice_text?: string | null; phone_transcribe_calls?: boolean } | null;
      text = noticeText(env, { notice_text: s?.phone_recording_notice_text ?? null, transcribe: s?.phone_transcribe_calls !== false });
      if (UUID_RE.test(callId)) ec.waitUntil(addCallEvent(admin, callId, "recording_notice", { leg: "out" }));
    } catch (e) {
      ec.waitUntil(logFault({
        code: "recording_notice_read_failed", severity: "warn", clientId, throttleMs: 10 * 60_000,
        message: `The announcement's wording could not be read; the standard sentence played. ${faultText(e)}`,
      }));
    }
  }
  return response(say(text));
}

// ── The sweep's backstop ────────────────────────────────────────────────────────────────

/** A recording still marked live this long after its call ended has lost its callback. */
const BACKSTOP_AFTER_MS = 10 * 60_000;
/** ...and one Twilio has no recording for, this long after, never started. */
const GIVE_UP_AFTER_MS = 60 * 60_000;
/** A call with no end written is checked once it is this old (Twilio ends a call at 4 hours). */
const UNENDED_AFTER_MS = 6 * 60 * 60_000;
const BACKSTOP_BATCH = 20;

type BackstopRow = RecordingRow & {
  created_at: string;
  phone_calls?: { twilio_call_sid: string | null; ended_at: string | null } | { twilio_call_sid: string | null; ended_at: string | null }[] | null;
};

/**
 * Every 15 minutes, beside the voicemail sweep: recordings still starting / recording / paused
 * whose call ended a while ago. Twilio's own list for the call says what happened: a completed
 * call recording completes the row (and queues its transcript) as the callback would have; none
 * at all an hour on means the start never reached Twilio (failed). One read when there is
 * nothing to do.
 */
export async function recordingBackstop(env: Env, admin: Admin, now = new Date()): Promise<{ checked: number; completed: number; failed: number }> {
  const out = { checked: 0, completed: 0, failed: 0 };
  if (!twilioConfigured(env)) return out;
  const rows = (must(
    await admin.from("phone_call_recordings")
      .select(`${REC_COLUMNS}, created_at, phone_calls(twilio_call_sid, ended_at)`)
      .in("status", ["starting", "recording", "paused"])
      .lt("created_at", new Date(now.getTime() - BACKSTOP_AFTER_MS).toISOString())
      .order("created_at", { ascending: true }).limit(BACKSTOP_BATCH),
    "read live call recordings",
  ) as BackstopRow[] | null) ?? [];
  for (const row of rows) {
    const c = Array.isArray(row.phone_calls) ? row.phone_calls[0] : row.phone_calls;
    const ended = Date.parse(c?.ended_at ?? "");
    const since = Number.isFinite(ended) ? now.getTime() - ended : now.getTime() - Date.parse(row.created_at) - UNENDED_AFTER_MS;
    if (!c?.twilio_call_sid || !(since >= BACKSTOP_AFTER_MS)) continue;
    out.checked++;
    try {
      const recs: TwilioRecording[] = await listCallRecordings(env, c.twilio_call_sid);
      const mine = row.recording_sid
        ? recs.find((r) => r.sid === row.recording_sid)
        : recs.find((r) => r.source === "StartCallRecordingAPI");
      if (mine?.status === "completed") {
        if (await completeRecording(env, admin, row, mine.sid, Number.parseInt(String(mine.duration ?? ""), 10)) === "completed") out.completed++;
      } else if (mine?.status === "absent" || (!mine && since >= GIVE_UP_AFTER_MS)) {
        await admin.from("phone_call_recordings").update({
          status: mine ? "absent" : "failed", completed_at: now.toISOString(),
          ...(mine ? { recording_sid: mine.sid } : { last_error: "Twilio has no recording for this call." }),
        }).eq("id", row.id).in("status", ["starting", "recording", "paused"]);
        out.failed++;
      }
    } catch (e) {
      await logFault({ code: "recording_backstop_failed", clientId: row.client_id, message: faultText(e), context: { recording: row.id } });
    }
  }
  if (out.completed || out.failed) {
    await logFault({
      code: "recording_backstop_filed", severity: "info",
      message: `The backstop settled ${out.completed + out.failed} call recording(s) whose callback was lost (${out.completed} completed).`,
    });
  }
  return out;
}

// ── Reading a call for the start ────────────────────────────────────────────────────────

/** The call's row for startCallRecording, read when the caller has none (the cell screen). */
export async function startForCallId(env: Env, callId: string): Promise<StartOutcome> {
  if (!recordingEnvOn(env) || !UUID_RE.test(callId)) return "skipped";
  const admin = adminClient(env);
  const call = await callById(admin, callId).catch(() => null);
  return call ? startCallRecording(env, admin, call) : "skipped";
}
