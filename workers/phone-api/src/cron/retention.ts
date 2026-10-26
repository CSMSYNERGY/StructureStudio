// Daily: delete voicemail recordings at Twilio once they pass the retention period (12 months,
// confirmed 09-29), which also stops Twilio's storage charge, then stamp deleted_at. The row
// stays, so the call history still shows that a message was left.
//
// A voicemail's transcript (TRANSCRIBE=on) goes with it, in both places it is kept: Twilio's
// copy (its Transcriptions under the recording, deleted first) and phone_voicemails.transcript
// (cleared with the stamp). The privacy policy promises it is kept as long as the voicemail.
//
// Call recordings (release B2, ../recording.ts) the same way, each by its own business's
// retention (client_settings.phone_recording_retention_days, 365 unless the owner chose 30, 90,
// 180 or 730; phone_recordings_expired picks them). The transcript goes with the audio and the
// summary stays (decided 2026-10-04), so the call still says what it was about.
//
// Each recording is deleted in the account it lives in: its business's sub-account once it has one
// (Workstream 2, phase 5: twilioAccount.ts envForClient). Off: the parent, nothing looked up.
//
// ⚠️ A 404 IN A SUB-ACCOUNT IS NOT "DONE" (2026-10-13). A business moved onto its own sub-account
// keeps every recording made before the move in the PARENT (moving a business moves no recordings),
// and the privacy policy promises voicemails, their transcripts and call recordings are deleted from
// Twilio when they expire. So when the business's current account is a sub and answers 404, the
// parent is asked too (deleteWherever) before the row is stamped. No earlier account is recorded
// anywhere (twilio_accounts keeps ONE row per business, its current one, and the recording rows
// carry no account), so the parent is the only other place a recording can be. A 404 in both means
// it is already gone, which counts as deleted, as before.
//
// Logs stay summary-only: a failure's code and the row's own id (never a SID, number or transcript),
// and one line of counts when the parent fallback found anything.

import type { Env } from "../env";
import { intVar } from "../env";
import { adminClient, must } from "../db";
import { logFault } from "../log";
import { deleteRecording, deleteRecordingTranscriptions, twilioConfigured } from "../twilioRest";
import { envForClient } from "../twilioAccount";

const BATCH = 200;

/**
 * Delete one recording wherever it is: the business's current account first, then, when that is a
 * sub-account that answers 404, the parent. `transcripts`: Twilio's own transcripts under it go
 * first, in the same account (a voicemail's; see deleteRecordingTranscriptions). Returns where it
 * was deleted ("current", "parent"), or "gone" when neither account has it. Throws what Twilio
 * refused, so the row is kept for the next run.
 */
export async function deleteWherever(
  parent: Env, current: Env, recordingSid: string, transcripts: boolean,
): Promise<"current" | "parent" | "gone"> {
  const deleteIn = async (acct: Env): Promise<boolean> => {
    if (transcripts) await deleteRecordingTranscriptions(acct, recordingSid);
    return deleteRecording(acct, recordingSid);
  };
  if (await deleteIn(current)) return "current";
  // The business is on the parent (or the switch is off): there is nowhere else to look.
  if (current === parent || current.TWILIO_ACCOUNT_SID === parent.TWILIO_ACCOUNT_SID) return "gone";
  return (await deleteIn(parent)) ? "parent" : "gone";
}

function sayParentCount(job: string, parent: number, deleted: number, failed: number): void {
  if (parent) console.log(`[phone-api] ${job}: ${JSON.stringify({ deleted, failed, from_parent: parent })}`);
}

export async function recordingRetention(env: Env, now = new Date()): Promise<{ deleted: number; failed: number; parent: number }> {
  if (!twilioConfigured(env)) return { deleted: 0, failed: 0, parent: 0 };
  const admin = adminClient(env);
  const rows = (must(
    await admin.rpc("phone_recordings_expired", { p_now: now.toISOString(), p_limit: BATCH }),
    "phone_recordings_expired",
  ) as { id: string; call_id: string; client_id: string; recording_sid: string | null }[] | null) ?? [];

  let deleted = 0;
  let failed = 0;
  let parent = 0;
  for (const r of rows) {
    try {
      // A recording already gone at Twilio, in its business's account and the parent, counts as deleted.
      if (r.recording_sid) {
        const where = await deleteWherever(env, await envForClient(env, admin, r.client_id), r.recording_sid, false);
        if (where === "parent") parent++;
      }
      const { error } = await admin.from("phone_call_recordings")
        .update({ deleted_at: new Date().toISOString(), transcript: null, transcript_json: null })
        .eq("id", r.id).is("deleted_at", null);
      if (error) throw new Error(error.message);
      deleted++;
    } catch (e) {
      failed++;
      await logFault({ code: "call_recording_retention_failed", clientId: r.client_id, message: (e as Error).message, context: { recording: r.id } });
    }
  }
  sayParentCount("call recording retention", parent, deleted, failed);
  return { deleted, failed, parent };
}

export async function retention(env: Env, now = new Date()): Promise<{ deleted: number; failed: number; parent: number }> {
  if (!twilioConfigured(env)) return { deleted: 0, failed: 0, parent: 0 };
  const admin = adminClient(env);
  const days = intVar(env.VOICEMAIL_RETENTION_DAYS, 365, 30);
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  const rows = (must(
    await admin.from("phone_voicemails").select("id, recording_sid, client_id")
      .is("deleted_at", null).lt("created_at", cutoff).order("created_at", { ascending: true }).limit(BATCH),
    "read expired voicemails",
  ) as { id: string; recording_sid: string | null; client_id: string }[] | null) ?? [];

  let deleted = 0;
  let failed = 0;
  let parent = 0;
  for (const r of rows) {
    try {
      if (r.recording_sid) {
        // Twilio's copy of the transcript first, in whichever account holds the recording: it is
        // listed through the recording.
        const where = await deleteWherever(env, await envForClient(env, admin, r.client_id), r.recording_sid, true);
        if (where === "parent") parent++;
      }
      const { error } = await admin.from("phone_voicemails").update({ deleted_at: new Date().toISOString(), transcript: null })
        .eq("id", r.id).is("deleted_at", null);
      if (error) throw new Error(error.message);
      deleted++;
    } catch (e) {
      failed++;
      await logFault({ code: "voicemail_retention_failed", clientId: r.client_id, message: (e as Error).message, context: { voicemail: r.id } });
    }
  }
  sayParentCount("voicemail retention", parent, deleted, failed);
  return { deleted, failed, parent };
}
