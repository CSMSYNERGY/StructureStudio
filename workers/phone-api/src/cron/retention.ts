// Daily: delete voicemail recordings at Twilio once they pass the retention period (12 months,
// confirmed 09-29), which also stops Twilio's storage charge, then stamp deleted_at. The row
// stays, so the call history still shows that a message was left.

import type { Env } from "../env";
import { intVar } from "../env";
import { adminClient, must } from "../db";
import { logFault } from "../log";
import { deleteRecording, twilioConfigured } from "../twilioRest";

const BATCH = 200;

export async function retention(env: Env, now = new Date()): Promise<{ deleted: number; failed: number }> {
  if (!twilioConfigured(env)) return { deleted: 0, failed: 0 };
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
  for (const r of rows) {
    try {
      if (r.recording_sid) await deleteRecording(env, r.recording_sid);
      const { error } = await admin.from("phone_voicemails").update({ deleted_at: new Date().toISOString() }).eq("id", r.id).is("deleted_at", null);
      if (error) throw new Error(error.message);
      deleted++;
    } catch (e) {
      failed++;
      await logFault({ code: "voicemail_retention_failed", clientId: r.client_id, message: (e as Error).message, context: { voicemail: r.id } });
    }
  }
  return { deleted, failed };
}
