// Every minute while CALL_TRANSCRIBE is "on": transcribe recorded calls, and ask for their
// summaries (release B2; how a call comes to be recorded is ../recording.ts).
//
// ── THE QUEUE (phone_call_recordings, migration 263) ───────────────────────────────────────
//   1. phone_recordings_claim(2, 300): at most two completed recordings per tick, leased for
//      5 minutes, FOR UPDATE SKIP LOCKED, attempts + 1, so overlapping ticks never take the
//      same one and a tick that dies leaves its rows to come back when the lease runs out.
//   2. Per row: the business still wants transcripts (read now: it may have turned them off
//      since the call); the audio from Twilio by its SID, both channels apart
//      (RequestedChannels=2); Workers AI @cf/deepgram/nova-3, multichannel; lines labelled
//      "Customer:" / "Team:" from the row's channel_map; stored with its utterances and what it
//      cost (an estimate); then the summary is due.
//   3. A failure backs off 1, 5, 15, 60 minutes and gives up (failed) after MAX_ATTEMPTS. A
//      recording Twilio no longer has fails at once.
//   4. Summaries: each recording whose summary is due gets one POST to the phone-call-summary
//      edge function (Claude; ANTHROPIC_API_KEY lives in Supabase secrets only). The function
//      claims the row itself (phone_recording_summary_claim), so asking twice never asks Claude
//      twice. Still pending 2 minutes later: asked again. Still not written a day after the
//      recording: given up.
// Not a bare waitUntil after the callback, on purpose: a transcript is minutes of work against
// two outside services, and the queue is what survives a fault, a deploy or a dead isolate.
//
// ⚠️ NO TRANSCRIPT OR SUMMARY TEXT EVER REACHES A LOG, phone_call_events OR app_errors. Faults
// carry the recording's id, a code and the first line of an error (Twilio's, Workers AI's or the
// database's), never anything a caller said. A mark on the call says only how many characters.

import type { Env } from "../env";
import { addCallEvent, must, type Admin } from "../db";
import { logFault } from "../log";
import { callTranscribeOn, CHANNEL_MAP } from "../recording";
import { recordingMedia, TwilioError, twilioConfigured } from "../twilioRest";
import { envForClient } from "../twilioAccount";

export const NOVA3_MODEL = "@cf/deepgram/nova-3";
/** Recordings per tick. */
export const CLAIM_LIMIT = 2;
export const LEASE_S = 300;
export const MAX_ATTEMPTS = 5;
/** Minutes until the next try, by the attempts the claim has counted (1 on the first). */
export const BACKOFF_MIN = [1, 5, 15, 60];
/**
 * Workers AI's nova-3 price per audio minute ($0.0052), in micros, and how many channels it is
 * assumed to bill: both, until the test call shows otherwise (plan section 14). An ESTIMATE,
 * recorded as stt_cost_micros and charged (once armed) as cost_source 'estimate'.
 */
export const NOVA3_MIN_MICROS = 5200;
export const NOVA3_CHANNELS_BILLED = 2;
/** migration 263's CHECK on phone_call_recordings.transcript. */
export const MAX_TRANSCRIPT = 100_000;
/** Words further apart than this (seconds) on one channel start a new line. */
const PAUSE_S = 1.5;
export const SUMMARY_RETRY_MS = 2 * 60_000;
export const SUMMARY_GIVE_UP_MS = 24 * 60 * 60_000;
export const SUMMARY_BATCH = 4;
/** How long one summary request may take (the edge function waits on Claude). */
export const SUMMARY_TIMEOUT_MS = 60_000;

export type Speaker = "customer" | "team";

/** One stretch of one person talking. Times are seconds into the recording. */
export interface Utterance {
  who: Speaker;
  start: number;
  end: number;
  text: string;
}

// ── From nova-3's answer to labelled lines (pure, exported for the tests) ──────────────────

function speakerOf(channel: number, map: unknown): Speaker {
  const m = map && typeof map === "object" ? (map as Record<string, unknown>)[String(channel)] : undefined;
  if (m === "customer" || m === "team") return m;
  return (CHANNEL_MAP[String(channel)] ?? (channel === 0 ? "customer" : "team"));
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * nova-3's multichannel answer as utterances in time order. Its own `utterances` when it gave
 * them; otherwise each channel's words, split where someone paused; otherwise each channel's
 * whole transcript. Empty for silence.
 */
export function utterancesOf(out: unknown, channelMap: unknown): Utterance[] {
  const results = (out as { results?: Record<string, unknown> } | null)?.results ?? {};
  const given = Array.isArray(results.utterances) ? results.utterances as Record<string, unknown>[] : null;
  let us: Utterance[] = [];
  if (given?.length) {
    us = given.map((u) => ({
      who: speakerOf(Array.isArray(u.channel) ? num(u.channel[0]) : num(u.channel), channelMap),
      start: num(u.start), end: num(u.end), text: str(u.transcript),
    }));
  } else {
    const channels = Array.isArray(results.channels) ? results.channels as Record<string, unknown>[] : [];
    channels.forEach((ch, i) => {
      const alt = (Array.isArray(ch?.alternatives) ? ch.alternatives[0] : null) as Record<string, unknown> | null;
      if (!alt) return;
      const who = speakerOf(i, channelMap);
      const words = Array.isArray(alt.words) ? alt.words as Record<string, unknown>[] : [];
      if (!words.length) {
        const text = str(alt.transcript);
        if (text) us.push({ who, start: 0, end: 0, text });
        return;
      }
      let cur: Utterance | null = null;
      for (const w of words) {
        const word = str(w.punctuated_word) || str(w.word);
        if (!word) continue;
        const start = num(w.start);
        const end = num(w.end) || start;
        if (cur && start - cur.end <= PAUSE_S) {
          cur.text += ` ${word}`;
          cur.end = end;
        } else {
          cur = { who, start, end, text: word };
          us.push(cur);
        }
      }
    });
  }
  return us.filter((u) => u.text).sort((a, b) => a.start - b.start || (a.who === b.who ? 0 : a.who === "customer" ? -1 : 1));
}

/**
 * The transcript as people read it: "Customer: ..." / "Team: ..." lines, one person's
 * consecutive utterances joined into one line, cut at a line boundary to fit MAX_TRANSCRIPT.
 */
export function transcriptOf(us: Utterance[], max = MAX_TRANSCRIPT): string {
  const lines: { who: Speaker; text: string }[] = [];
  for (const u of us) {
    const last = lines[lines.length - 1];
    if (last && last.who === u.who) last.text += ` ${u.text}`;
    else lines.push({ who: u.who, text: u.text });
  }
  let out = "";
  for (const l of lines) {
    const line = `${l.who === "customer" ? "Customer" : "Team"}: ${l.text}`;
    const next = out ? `${out}\n${line}` : line;
    if (next.length > max) {
      if (!out) out = line.slice(0, max);
      break;
    }
    out = next;
  }
  return out;
}

/** The utterances kept as transcript_json: as many as fit the transcript's own cap. */
export function utterancesToKeep(us: Utterance[], max = MAX_TRANSCRIPT): Utterance[] {
  const kept: Utterance[] = [];
  let chars = 0;
  for (const u of us) {
    chars += u.text.length;
    if (chars > max) break;
    kept.push({ who: u.who, start: Math.round(u.start * 100) / 100, end: Math.round(u.end * 100) / 100, text: u.text });
  }
  return kept;
}

/** nova-3's cost for a recording this long: whole minutes, rounded up, both channels. */
export function sttCostMicros(durationS: number | null | undefined): number {
  const minutes = Math.max(1, Math.ceil((Number(durationS) || 0) / 60));
  return minutes * NOVA3_MIN_MICROS * NOVA3_CHANNELS_BILLED;
}

export function backoffMinutes(attempts: number): number {
  const i = Math.min(Math.max(1, attempts), BACKOFF_MIN.length) - 1;
  return BACKOFF_MIN[i];
}

// ── The run ─────────────────────────────────────────────────────────────────────────────

interface ClaimedRow {
  id: string;
  call_id: string;
  client_id: string;
  recording_sid: string | null;
  duration_s: number | null;
  channel_map: unknown;
  attempts: number;
}

export interface TranscribeRun {
  ran: boolean;
  reason?: "switched_off" | "not_configured";
  claimed: number;
  done: number;
  off: number;
  retried: number;
  failed: number;
  summaries: number;
}

/** A failure that no retry can fix (the audio is gone). */
class Permanent extends Error {}

function errorLine(e: unknown): string {
  if (e instanceof TwilioError) return e.message;
  return String((e as Error)?.message ?? e).split("\n")[0].slice(0, 300);
}

export async function runTranscriptions(env: Env, admin: Admin, now = new Date()): Promise<TranscribeRun> {
  const run: TranscribeRun = { ran: false, claimed: 0, done: 0, off: 0, retried: 0, failed: 0, summaries: 0 };
  if (!callTranscribeOn(env)) return { ...run, reason: "switched_off" };
  if (!env.AI || !twilioConfigured(env)) {
    await logFault({
      code: "call_transcribe_not_configured", once: true,
      message: "CALL_TRANSCRIBE is on, but the Worker has no Workers AI binding (\"ai\" in wrangler.jsonc) or no Twilio credentials: no call is being transcribed.",
    });
    return { ...run, reason: "not_configured" };
  }
  run.ran = true;
  const rows = (must(await admin.rpc("phone_recordings_claim", { p_limit: CLAIM_LIMIT, p_lease_s: LEASE_S }), "phone_recordings_claim") as ClaimedRow[] | null) ?? [];
  run.claimed = rows.length;
  if (rows.length) {
    // Re-read: a business that turned transcripts off since the call gets none. A failed read
    // transcribes nothing this tick (the leases run out and the rows come back).
    const settings = (must(
      await admin.from("client_settings").select("client_id, phone_transcribe_calls").in("client_id", [...new Set(rows.map((r) => r.client_id))]),
      "read transcript settings",
    ) as { client_id: string; phone_transcribe_calls?: boolean }[] | null) ?? [];
    const wants = new Map(settings.map((s) => [s.client_id, s.phone_transcribe_calls !== false]));
    for (const row of rows) run[await transcribeOne(env, admin, row, wants.get(row.client_id) === true, now)]++;
  }
  run.summaries = await requestDueSummaries(env, admin, now);
  return run;
}

async function transcribeOne(env: Env, admin: Admin, row: ClaimedRow, wanted: boolean, now: Date): Promise<"done" | "off" | "retried" | "failed"> {
  const settle = async (patch: Record<string, unknown>) => {
    const { error } = await admin.from("phone_call_recordings").update({ ...patch, lease_until: null })
      .eq("id", row.id).eq("transcript_status", "working");
    if (error) {
      // The code only: a Postgres message about this row could quote the transcript it was writing.
      await logFault({ code: "call_transcribe_write_failed", clientId: row.client_id, message: `phone_call_recordings update failed (database code ${error.code ?? "none"}).`, context: { recording: row.id } });
    }
  };
  if (!wanted) {
    await settle({ transcript_status: "off", summary_status: "off", next_try_at: null });
    return "off";
  }
  try {
    if (!row.recording_sid) throw new Permanent("the row has no recording");
    // In the account the recording lives in (Workstream 2, phase 5): its business's sub-account
    // once it has one. Off: `env` itself. A sub that cannot be resolved is retried like any fetch.
    const media = await recordingMedia(await envForClient(env, admin, row.client_id), row.recording_sid, null, 2);
    if (media.status === 404) throw new Permanent("Twilio no longer has the recording");
    if (!media.ok || !media.body) throw new Error(`Twilio answered HTTP ${media.status} for the audio`);
    const out = await env.AI!.run(NOVA3_MODEL, {
      audio: { body: media.body, contentType: "audio/mpeg" },
      multichannel: true,
      utterances: true,
      smart_format: true,
      punctuate: true,
      // These are customers' conversations: not for Deepgram's model improvement.
      mip_opt_out: true,
    });
    const us = utterancesOf(out, row.channel_map);
    const text = transcriptOf(us);
    // Silence (or nothing nova-3 could make out) is a finished transcript with nothing in it:
    // nothing to summarise.
    await settle({
      transcript: text || null,
      transcript_json: text ? utterancesToKeep(us) : null,
      transcript_status: "done",
      stt_cost_micros: sttCostMicros(row.duration_s),
      last_error: null,
      next_try_at: null,
      summary_status: text ? "pending" : "off",
      summary_next_at: text ? now.toISOString() : null,
    });
    await addCallEvent(admin, row.call_id, "call_transcribed", { chars: text.length, lines: text ? text.split("\n").length : 0 });
    return "done";
  } catch (e) {
    const why = errorLine(e);
    if (e instanceof Permanent || row.attempts >= MAX_ATTEMPTS) {
      await settle({ transcript_status: "failed", summary_status: "off", last_error: why.slice(0, 500), next_try_at: null });
      await logFault({
        code: "call_transcribe_failed", clientId: row.client_id,
        message: `A call recording could not be transcribed after ${row.attempts} attempt(s): ${why}`, context: { recording: row.id },
      });
      return "failed";
    }
    await settle({
      transcript_status: "pending", last_error: why.slice(0, 500),
      next_try_at: new Date(now.getTime() + backoffMinutes(row.attempts) * 60_000).toISOString(),
    });
    await logFault({
      code: "call_transcribe_retry", severity: "warn", clientId: row.client_id, throttleMs: 10 * 60_000,
      message: `A call transcript will be retried: ${why}`, context: { recording: row.id },
    });
    return "retried";
  }
}

// ── Summaries ───────────────────────────────────────────────────────────────────────────

/**
 * Ask the phone-call-summary edge function for one recording's summary, as the service role
 * (wallet.ts requestAutoTopup's door: the bearer and apikey, checked inside the function in
 * constant time). Resolves true on a 2xx; NEVER throws. Only the HTTP status is ever logged.
 */
export async function requestCallSummary(env: Env, recordingId: string): Promise<boolean> {
  const base = String(env.SUPABASE_URL ?? "").replace(/\/+$/, "");
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!base || !key) return false;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), SUMMARY_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/functions/v1/phone-call-summary`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}`, apikey: key },
      body: JSON.stringify({ recording_id: recordingId }),
      signal: ac.signal,
    });
    await res.arrayBuffer().catch(() => undefined);
    if (res.ok) return true;
    await logFault({
      code: "call_summary_request_failed", throttleMs: 10 * 60_000,
      message: `phone-call-summary answered HTTP ${res.status}.`, context: { recording: recordingId },
    });
    return false;
  } catch (e) {
    await logFault({
      code: "call_summary_request_failed", throttleMs: 10 * 60_000,
      message: ac.signal.aborted ? `phone-call-summary did not answer in ${SUMMARY_TIMEOUT_MS / 1000} s.` : `phone-call-summary unreachable: ${errorLine(e)}`,
      context: { recording: recordingId },
    });
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The summaries due now: one request each, at the same time. Each is first moved 2 minutes on
 * (a conditional write on the time it had), so two overlapping ticks never both ask. A summary
 * still not written a day after its recording ended is given up as failed.
 */
async function requestDueSummaries(env: Env, admin: Admin, now: Date): Promise<number> {
  const due = (must(
    await admin.from("phone_call_recordings").select("id, client_id, summary_next_at, completed_at")
      .eq("transcript_status", "done").in("summary_status", ["pending", "working"]).is("deleted_at", null)
      .lte("summary_next_at", now.toISOString()).order("summary_next_at", { ascending: true }).limit(SUMMARY_BATCH),
    "read summaries due",
  ) as { id: string; client_id: string; summary_next_at: string; completed_at: string | null }[] | null) ?? [];
  const asks: string[] = [];
  for (const r of due) {
    const ended = Date.parse(r.completed_at ?? "");
    if (Number.isFinite(ended) && now.getTime() - ended > SUMMARY_GIVE_UP_MS) {
      await admin.from("phone_call_recordings").update({ summary_status: "failed", summary_next_at: null, lease_until: null, last_error: "The summary was not written within a day." })
        .eq("id", r.id).in("summary_status", ["pending", "working"]);
      await logFault({ code: "call_summary_gave_up", clientId: r.client_id, message: "A call summary was not written within a day; given up.", context: { recording: r.id } });
      continue;
    }
    const { data } = await admin.from("phone_call_recordings")
      .update({ summary_next_at: new Date(now.getTime() + SUMMARY_RETRY_MS).toISOString() })
      .eq("id", r.id).eq("summary_next_at", r.summary_next_at).select("id");
    if (Array.isArray(data) && data.length) asks.push(r.id);
  }
  await Promise.all(asks.map((id) => requestCallSummary(env, id)));
  return asks.length;
}
