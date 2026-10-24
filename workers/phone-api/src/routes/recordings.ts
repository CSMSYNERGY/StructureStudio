// GET /recordings/:id/audio and GET /calls/:id/transcript (release B2, ../recording.ts).
//
// The audio stays at Twilio and is streamed through here, the way voicemail is (./calls.ts
// voicemailAudio), with three differences on purpose:
//   - the header bearer only, never ?access_token=: no app build ever played a call recording
//     through <audio src>, so there is no old build to keep working;
//   - only a recording Twilio has finished (completed) plays; a live one says it is not ready;
//   - nothing is marked as listened to (a call recording is not a message waiting for someone).
// WHO MAY HEAR IT, AND READ ITS TRANSCRIPT: the rule voicemail has (mayViewCall): the caller's
// own tenant, the contacts row scope, the call's people, and the team's calls for phone view/edit.
// Gone (404) once retention has deleted the audio; the transcript goes with it.

import type { Ctx, Env } from "../env";
import { requireCaller, type Caller } from "../context";
import { withTeamName } from "../cron/transcribe";
import { CALL_COLUMNS, DbError, must, type CallRow } from "../db";
import { ApiError, ok, UUID_RE } from "../http";
import { logFault } from "../log";
import { recordingMedia } from "../twilioRest";
import { mayViewCall, resolveCall } from "./calls";
import { callerTwilioEnv } from "../twilioAccount";
import { transcriptTeamUser } from "../../../../supabase/functions/_shared/crmFeed.ts";

interface RecordingRead {
  id: string;
  call_id: string;
  client_id: string;
  recording_sid: string | null;
  status: string;
  deleted_at: string | null;
}

export async function recordingAudio(env: Env, _ec: Ctx, req: Request, id: string): Promise<Response> {
  const c = await requireCaller(env, req, { needOn: false });
  // Workstream 2, phase 5: this business's Twilio account (its sub-account's, or the parent's).
  env = await callerTwilioEnv(env, c);
  const notFound = () => new ApiError("not_found", "That recording wasn't found.");
  if (!UUID_RE.test(id)) throw notFound();
  const rec = must(
    await c.admin.from("phone_call_recordings").select("id, call_id, client_id, recording_sid, status, deleted_at").eq("id", id).maybeSingle(),
    "read call recording",
  ) as RecordingRead | null;
  if (!rec || rec.client_id !== c.ctx.client_id || !rec.recording_sid) throw notFound();
  const call = must(await c.admin.from("phone_calls").select(CALL_COLUMNS).eq("id", rec.call_id).maybeSingle(), "read call") as CallRow | null;
  if (!call || !(await mayViewCall(c, call))) throw notFound();
  if (rec.deleted_at) throw new ApiError("not_found", "That recording is no longer available.");
  if (rec.status !== "completed") throw new ApiError("not_found", "The recording isn't ready yet. Try again in a minute.");

  let media: Response;
  try {
    // One channel: Twilio mixes the two, so both people play in both ears.
    media = await recordingMedia(env, rec.recording_sid, req.headers.get("range"));
  } catch {
    throw new ApiError("twilio_error", "The recording couldn't be loaded. Please try again.");
  }
  if (media.status === 404) throw new ApiError("not_found", "That recording is no longer available.");
  if (!media.ok) throw new ApiError("twilio_error", "The recording couldn't be loaded. Please try again.");

  const headers = new Headers({
    "content-type": "audio/mpeg",
    "cache-control": "private, no-store",
    "accept-ranges": "bytes",
  });
  for (const h of ["content-length", "content-range"]) {
    const v = media.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new Response(media.body, { status: media.status, headers });
}

/**
 * The call's transcript, read when someone presses "Show transcript". GET /calls and GET
 * /threads/:key never carry it (the apps save those rows on the device, where a copy would
 * outlive the business's retention); their `transcript_status: "done"` says this has it. `:id`
 * is the phone_calls id or either leg's CallSid, as for the other /calls/:id endpoints.
 */
export async function callTranscript(env: Env, req: Request, idParam: string): Promise<Response> {
  const c = await requireCaller(env, req, { needOn: false });
  const call = await resolveCall(c, idParam);
  if (!call || !(await mayViewCall(c, call))) throw new ApiError("not_found", "That call wasn't found.");
  const rec = must(
    await c.admin.from("phone_call_recordings").select("id, transcript, summary, deleted_at").eq("call_id", call.id).maybeSingle(),
    "read call transcript",
  ) as { id: string; transcript: string | null; summary: string | null; deleted_at: string | null } | null;
  if (!rec || rec.deleted_at || !rec.transcript) throw new ApiError("not_found", "This call has no transcript.");
  const transcript = await namedTranscript(c, call, rec.transcript);
  return ok({ call_id: call.id, recording_id: rec.id, transcript, summary: rec.summary ?? null });
}

/**
 * The stored transcript with our side's lines under the team member's name (Carolyn 2026-10-23,
 * 24:13; withTeamName), from their client_users full_name in this business. WHO is the portal's
 * own rule, the same function (crmFeed.ts transcriptTeamUser), so the record page and the apps
 * name the same person: the team channel is everyone on our side of the call, so it is one person
 * only when one person was on it, who placed it (outbound) or answered it (inbound). A transfer,
 * a message left on the call (the greeting plays on that channel), nobody answering, or no name
 * set keeps "Team". The two reads only happen for a transcript that has a "Team" line on a call
 * with one person on it. A failed read still returns the transcript, with "Team", and logs the
 * database's code, never the text.
 */
async function namedTranscript(c: Caller, call: CallRow, text: string): Promise<string> {
  const who = transcriptTeamUser({ ...call, phone_voicemails: null });
  if (!who || !/^Team: /m.test(text)) return text;
  try {
    const [vm, person] = await Promise.all([
      c.admin.from("phone_voicemails").select("id").eq("call_id", call.id).limit(1),
      c.admin.from("client_users").select("full_name").eq("client_id", call.client_id).eq("user_id", who).maybeSingle(),
    ]);
    const left = (must(vm, "read call voicemail") as { id: string }[] | null) ?? [];
    const row = must(person, "read team member name") as { full_name: string | null } | null;
    if (transcriptTeamUser({ ...call, phone_voicemails: left }) !== who) return text;
    return withTeamName(text, row?.full_name);
  } catch (e) {
    await logFault({
      code: "transcript_name_read_failed",
      message: `The team member's name for a transcript could not be read (${e instanceof DbError ? `${e.op}: ${e.pgCode ?? "no code"}` : "unexpected"}); "Team" kept.`,
      context: { route: "GET /calls/:id/transcript" }, clientId: c.ctx.client_id, severity: "warn", throttleMs: 60_000,
    });
    return text;
  }
}
