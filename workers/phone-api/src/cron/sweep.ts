// Every 15 minutes: file any voicemail recording the webhooks missed.
//
// The usual cause is the Voice Fallback URL: while the Worker (or Supabase) is down, a number's
// fallback TwiML Bin plays the greeting and records, and nothing tells us. Those calls have no
// phone_calls row at all, so the sweep creates one from Twilio's own call record, routed by the
// number that was called. A recording whose number is not one of ours is left alone.

import type { Env } from "../env";
import { adminClient, must, routeForNumber, type Admin } from "../db";
import { phoneDigits } from "../identity";
import { logFault } from "../log";
import { fetchCall, listRecordings, twilioConfigured, type TwilioRecording } from "../twilioRest";
import { fileVoicemail, MIN_VOICEMAIL_SECONDS } from "../routes/voice";

const MAX_PER_RUN = 50;

async function callIdForRecording(env: Env, admin: Admin, rec: TwilioRecording, known: Map<string, string>): Promise<string | null> {
  const existing = known.get(rec.call_sid);
  if (existing) return existing;

  const tc = await fetchCall(env, rec.call_sid);
  if (!tc || tc.direction !== "inbound") return null;
  const info = await routeForNumber(admin, tc.to);
  if (!info) return null; // not a number this product answers

  let contactId: string | null = null;
  const digits = phoneDigits(tc.from);
  if (digits) {
    const { data } = await admin.from("crm_contacts").select("id").eq("client_id", info.client_id)
      .eq("phone_digits", digits).is("merged_into", null).order("updated_at", { ascending: false }).limit(1).maybeSingle();
    contactId = (data as { id?: string } | null)?.id ?? null;
  }
  const id = crypto.randomUUID();
  const { error } = await admin.from("phone_calls").insert({
    id, client_id: info.client_id, number_id: info.number_id, contact_id: contactId, direction: "in",
    from_e164: String(tc.from || "unknown").slice(0, 40), to_e164: tc.to, twilio_call_sid: tc.sid,
    status: "ringing", started_at: tc.start_time ? new Date(tc.start_time).toISOString() : new Date(rec.date_created).toISOString(),
    ended_at: new Date(rec.date_created).toISOString(),
  });
  if (error) {
    // Lost a race with a late webhook (twilio_call_sid is unique): use the row that won.
    const { data } = await admin.from("phone_calls").select("id").eq("twilio_call_sid", tc.sid).maybeSingle();
    return (data as { id?: string } | null)?.id ?? null;
  }
  return id;
}

export async function recordingSweep(env: Env, now = new Date()): Promise<{ checked: number; filed: number }> {
  if (!twilioConfigured(env)) return { checked: 0, filed: 0 };
  const admin = adminClient(env);
  // Twilio filters by DAY, so yesterday is included to cover a run just after midnight UTC.
  const since = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  const recs = (await listRecordings(env, since, 200))
    .filter((r) => r.status === "completed" && Number(r.duration) >= MIN_VOICEMAIL_SECONDS && r.call_sid);
  if (!recs.length) return { checked: 0, filed: 0 };

  // Filed means fileVoicemail ran: it is the only writer of duration_s (and of the call's
  // 'voicemail' status). A row with the recording but no duration was created by a transcript
  // that arrived first (routes/voice.ts fileTranscript) and still needs filing; fileVoicemail's
  // upsert keeps its transcript.
  const filed = new Set(((must(
    await admin.from("phone_voicemails").select("recording_sid, duration_s").in("recording_sid", recs.map((r) => r.sid)),
    "read filed recordings",
  ) as { recording_sid: string; duration_s: number | null }[] | null) ?? [])
    .filter((r) => r.duration_s != null).map((r) => r.recording_sid));
  const missing = recs.filter((r) => !filed.has(r.sid)).slice(0, MAX_PER_RUN);
  if (!missing.length) return { checked: recs.length, filed: 0 };

  const known = new Map<string, string>();
  for (const r of (must(
    await admin.from("phone_calls").select("id, twilio_call_sid").in("twilio_call_sid", [...new Set(missing.map((m) => m.call_sid))]),
    "match recordings to calls",
  ) as { id: string; twilio_call_sid: string }[] | null) ?? []) known.set(r.twilio_call_sid, r.id);

  let count = 0;
  for (const rec of missing) {
    try {
      const callId = await callIdForRecording(env, admin, rec, known);
      if (callId && await fileVoicemail(admin, callId, rec.sid, Number(rec.duration))) count++;
    } catch (e) {
      await logFault({ code: "recording_sweep_item_failed", message: (e as Error).message, context: { recording: rec.sid } });
    }
  }
  if (count) {
    await logFault({ code: "recording_sweep_filed", severity: "info", message: `The sweep filed ${count} voicemail(s) the webhooks missed.` });
  }
  return { checked: recs.length, filed: count };
}
