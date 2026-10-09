// Your own voicemail greeting (migration 264), the app side: POST /settings/me/greeting/record,
// GET /settings/me/greeting/audio and POST /settings/me/greeting/clear. Twilio's side (the
// recording call's TwiML, saving it, and the audio <Play> fetches) is ../greeting.ts.
//
// Everyone records their own: no owner or admin is involved, and nobody can record or clear
// anyone else's (each endpoint acts on the signed-in person only).

import type { Ctx, Env } from "../env";
import { requireCaller } from "../context";
import { must } from "../db";
import { ApiError, ok } from "../http";
import { toIdentity } from "../identity";
import { logFault } from "../log";
import { dropRecording, GREETING_PURPOSE, GREETING_RING_SECONDS, GREETING_SID_RE } from "../greeting";
import { createCall, recordingMedia, type TwilioError } from "../twilioRest";
import { hook } from "../urls";
import { SETTINGS_COLUMNS, settingsOut, type SettingsRow } from "./me";
import { callerTwilioEnv } from "../twilioAccount";

// ── POST /settings/me/greeting/record ───────────────────────────────────────────────

/** One recording ring per person per half minute, per isolate: a second press must not ring twice. */
export const GREETING_RING_GAP_MS = 30_000;
const lastRing = new Map<string, number>();

/** Tests only. */
export function resetGreetingRings(): void {
  lastRing.clear();
}

const WAIT_TEXT = "Your phone is already ringing for your greeting. Try again in half a minute.";

/**
 * Ring the person's own app to record their greeting. Their app rings like a call From the
 * business number, carrying purpose=greeting so it can say "Recording your voicemail greeting"
 * (older builds just show a call from the business number). Answering it plays the instructions
 * and records (../greeting.ts /voice/greeting). Needs calling switched on and a business number
 * (the ring comes from it). Answers {ok, ringing: true} once Twilio has placed the ring; the new
 * greeting shows in GET /settings/me (`greeting.updated_at`) once it is saved.
 */
export async function recordGreeting(env: Env, ec: Ctx, req: Request): Promise<Response> {
  const c = await requireCaller(env, req);
  // Workstream 2, phase 5: this business's Twilio account (its sub-account's, or the parent's).
  env = await callerTwilioEnv(env, c);
  if (!c.ctx.number) throw new ApiError("no_number");
  const now = Date.now();
  const last = lastRing.get(c.userId) ?? 0;
  if (now - last < GREETING_RING_GAP_MS) throw new ApiError("bad_request", WAIT_TEXT, 429);
  lastRing.set(c.userId, now);
  try {
    await createCall(env, {
      to: `client:${toIdentity(c.userId, c.ctx.device_generation)}?${new URLSearchParams({ purpose: GREETING_PURPOSE })}`,
      from: c.ctx.number.e164,
      // `t` is when this ring began: the recording it makes never replaces a greeting saved later.
      url: hook(env, "/voice/greeting", { user: c.userId, t: now, stage: "ask" }),
      timeout: GREETING_RING_SECONDS,
      statusCallback: hook(env, "/voice/greeting", { stage: "status" }),
      statusCallbackEvent: ["completed"],
    });
  } catch (e) {
    // Nothing rang: the person may press again straight away.
    lastRing.delete(c.userId);
    const te = e as TwilioError;
    ec.waitUntil(logFault({
      code: "greeting_ring_failed", clientId: c.ctx.client_id,
      message: `Ringing the person's app to record a greeting failed (HTTP ${te?.status ?? 0}, code ${te?.code ?? 0}).`,
    }));
    throw new ApiError("ring_failed", "Couldn't ring your phone. Please try again.");
  }
  return ok({ ringing: true });
}

// ── GET /settings/me/greeting/audio ─────────────────────────────────────────────────

async function myRow(c: Awaited<ReturnType<typeof requireCaller>>): Promise<SettingsRow | null> {
  return must(
    await c.admin.from("phone_user_settings").select(SETTINGS_COLUMNS).eq("user_id", c.userId).maybeSingle(),
    "read phone settings",
  ) as SettingsRow | null;
}

/**
 * Your own greeting's audio, streamed from Twilio, for the Play button. The login in the
 * Authorization header only (never ?access_token=). 404 when you have none.
 */
export async function myGreetingAudio(env: Env, req: Request): Promise<Response> {
  const c = await requireCaller(env, req, { needOn: false });
  // Workstream 2, phase 5: this business's Twilio account (its sub-account's, or the parent's).
  env = await callerTwilioEnv(env, c);
  const sid = (await myRow(c))?.greeting_recording_sid ?? null;
  if (!sid || !GREETING_SID_RE.test(sid)) throw new ApiError("not_found", "You haven't recorded a greeting.");
  let media: Response;
  try {
    media = await recordingMedia(env, sid, req.headers.get("range"));
  } catch {
    throw new ApiError("twilio_error", "Your greeting couldn't be loaded. Please try again.");
  }
  if (media.status === 404) throw new ApiError("not_found", "Your greeting isn't available. Record it again.");
  if (!media.ok) throw new ApiError("twilio_error", "Your greeting couldn't be loaded. Please try again.");
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

// ── POST /settings/me/greeting/clear ────────────────────────────────────────────────

/**
 * Back to the standard greeting ("Use the standard greeting"): forget your recording, then delete
 * it at Twilio. Forgotten first, so no voicemail plays it from here on even if the delete fails
 * (which is logged with the sid, to delete by hand). greeting_updated_at is stamped with the
 * clear, so a recording callback that arrives late can't put the greeting back (../greeting.ts
 * saveGreeting); the apps read no time without a greeting (me.ts greetingOut). Answers your
 * settings, as POST /settings/me does. Nothing to clear is not an error.
 */
export async function clearGreeting(env: Env, ec: Ctx, req: Request): Promise<Response> {
  const c = await requireCaller(env, req, { needOn: false });
  // Workstream 2, phase 5: this business's Twilio account (its sub-account's, or the parent's).
  env = await callerTwilioEnv(env, c);
  const row = await myRow(c);
  const sid = row?.greeting_recording_sid ?? null;
  if (!sid) return ok({ settings: settingsOut(row) });
  const now = new Date().toISOString();
  const saved = must(
    await c.admin.from("phone_user_settings")
      .update({ greeting_recording_sid: null, greeting_updated_at: now, updated_at: now })
      .eq("user_id", c.userId).eq("greeting_recording_sid", sid)
      .select(SETTINGS_COLUMNS),
    "clear greeting",
  ) as SettingsRow[] | null;
  // Changed under us (a new recording landed meanwhile): leave that one alone, and say what's saved.
  if (!saved?.length) return ok({ settings: settingsOut(await myRow(c)) });
  ec.waitUntil(dropRecording(env, sid, c.ctx.client_id, "cleared"));
  return ok({ settings: settingsOut(saved[0]) });
}
