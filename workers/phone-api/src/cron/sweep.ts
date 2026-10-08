// Every 15 minutes: file any voicemail recording the webhooks missed.
//
// The usual cause is the Voice Fallback URL: while the Worker (or Supabase) is down, a number's
// fallback TwiML Bin plays the greeting and records, and nothing tells us. Those calls have no
// phone_calls row at all, so the sweep creates one from Twilio's own call record, routed by the
// number that was called. A recording whose number is not one of ours is left alone.
//
// ONLY <Record> RECORDINGS ARE VOICEMAILS (source RecordVerb). Twilio lists every recording on
// the account, and once calls are recorded that includes call recordings (source
// StartCallRecordingAPI, started by src/recording.ts on the customer's leg of an answered call).
// One of those carries the call's SID the way a voicemail does, so without the source filter the
// sweep would file a recorded conversation as a voicemail, flip the call to 'voicemail' and count
// it in the Calls report. Nothing that is not RecordVerb (a call recording, a <Dial record>, a
// conference recording) is ever filed. A person's voicemail GREETING is a RecordVerb recording too
// (migration 264, ../greeting.ts), but on the ring the Worker placed to their own app: an
// outbound-api call with no phone_calls row, which callIdForRecording below never files. A STORED
// greeting is also set aside before the per-run cap: it is never filed, so otherwise every live
// greeting from the last two days would take one of the MAX_PER_RUN slots on every run.
//
// THE LIST IS READ TO THE END (up to LIST_MAX). It used to stop at the newest 200; once calls are
// recorded, those 200 can all be call recordings, hiding a real voicemail behind them.
//
// EVERY ACCOUNT (Workstream 2, phase 5). A sub-account's recordings are listed only by the sub
// itself, so with TWILIO_SUBACCOUNTS on the sweep runs once for the parent and once for each active
// sub-account (twilioAccount.ts cronAccounts), each with that account's credentials, and a sub's
// run files only recordings on its own business's numbers. Off: the parent alone, exactly as before.

import type { Env } from "../env";
import { adminClient, must, routeForNumber, type Admin } from "../db";
import { phoneDigits } from "../identity";
import { logFault } from "../log";
import { fetchCall, listRecordings, twilioConfigured, type TwilioRecording } from "../twilioRest";
import { fileVoicemail, MIN_VOICEMAIL_SECONDS } from "../routes/voice";
import { cronAccounts } from "../twilioAccount";

const MAX_PER_RUN = 50;
/**
 * Recordings read per run (pages of 100) from the two days the sweep looks at. Far above the
 * account's volume; a run that reaches it says so (info), because anything past it goes unchecked.
 */
export const LIST_MAX = 2000;
/** The one recording source that is a voicemail: the <Record> verb (Twilio's Recording.source). */
export const VOICEMAIL_SOURCE = "RecordVerb";

async function callIdForRecording(
  env: Env, admin: Admin, rec: TwilioRecording, known: Map<string, string>, onlyClient: string | null,
): Promise<string | null> {
  const existing = known.get(rec.call_sid);
  if (existing) return existing;

  const tc = await fetchCall(env, rec.call_sid);
  if (!tc || tc.direction !== "inbound") return null;
  const info = await routeForNumber(admin, tc.to);
  if (!info) return null; // not a number this product answers
  // A sub-account's recording is only ever its own business's (one tenant, one account).
  if (onlyClient && info.client_id !== onlyClient) return null;

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
  const out = { checked: 0, filed: 0 };
  // The parent first; a sub's failure is logged and the others go on. A failure of the parent's is
  // the job's failure, as it always was, but only after every sub has had its turn.
  let parentError: unknown = null;
  for (const a of await cronAccounts(env, admin)) {
    try {
      const r = await sweepAccount(a.env, admin, now, a.clientId);
      out.checked += r.checked;
      out.filed += r.filed;
    } catch (e) {
      if (!a.clientId) { parentError = e; continue; }
      await logFault({ code: "recording_sweep_failed", clientId: a.clientId, message: `The voicemail sweep failed for a sub-account: ${(e as Error).message}` });
    }
  }
  if (parentError) throw parentError;
  return out;
}

/** One account's sweep. `onlyClient`: a sub-account's business (null for the parent). */
async function sweepAccount(env: Env, admin: Admin, now: Date, onlyClient: string | null): Promise<{ checked: number; filed: number }> {
  // Twilio filters by DAY, so yesterday is included to cover a run just after midnight UTC.
  const since = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  const listed = await listRecordings(env, since, LIST_MAX);
  if (listed.length >= LIST_MAX) {
    await logFault({
      code: "recording_sweep_list_capped", severity: "info", throttleMs: 6 * 60 * 60_000,
      message: `The sweep read its limit of ${LIST_MAX} recordings; older ones in its two days were not checked.`,
    });
  }
  const recs = listed.filter((r) => r.source === VOICEMAIL_SOURCE && r.status === "completed"
    && Number(r.duration) >= MIN_VOICEMAIL_SECONDS && r.call_sid);
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
  // Greetings out BEFORE the cap. A team recording theirs on one day (more than MAX_PER_RUN of
  // them, account-wide, within the two days listed) would otherwise fill every run's slots and push
  // a real missed voicemail out of reach until it aged out of the listing. A failed read (or a
  // database before 264) sets nothing aside, as before: callIdForRecording still never files one.
  const unfiled = recs.filter((r) => !filed.has(r.sid));
  const greetings = new Set<string>();
  if (unfiled.length) {
    const g = await admin.from("phone_user_settings").select("greeting_recording_sid").in("greeting_recording_sid", unfiled.map((r) => r.sid));
    if (!g.error) {
      for (const r of (g.data as { greeting_recording_sid: string | null }[] | null) ?? []) {
        if (r.greeting_recording_sid) greetings.add(r.greeting_recording_sid);
      }
    }
  }
  const missing = unfiled.filter((r) => !greetings.has(r.sid)).slice(0, MAX_PER_RUN);
  if (!missing.length) return { checked: recs.length, filed: 0 };

  const known = new Map<string, string>();
  for (const r of (must(
    await admin.from("phone_calls").select("id, twilio_call_sid").in("twilio_call_sid", [...new Set(missing.map((m) => m.call_sid))]),
    "match recordings to calls",
  ) as { id: string; twilio_call_sid: string }[] | null) ?? []) known.set(r.twilio_call_sid, r.id);

  let count = 0;
  for (const rec of missing) {
    try {
      const callId = await callIdForRecording(env, admin, rec, known, onlyClient);
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
