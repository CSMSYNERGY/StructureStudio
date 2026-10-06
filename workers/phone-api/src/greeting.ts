// Each person's own voicemail greeting (migration 264), recorded BY PHONE: Twilio's side of it.
//
// Carolyn, 2026-09-30: "I want them to be able to go in the phone system and set up their own
// voicemail. GHL, you have to send it to an admin." So nobody sends anyone a file:
//   1. POST /settings/me/greeting/record (routes/greeting.ts) rings the person's own app, with
//      purpose=greeting on the ring so the app can say what it is;
//   2. answered, /voice/greeting (stage ask) says what to do and <Record>s up to 60 seconds;
//   3. its action (stage saved; the recording's status callback too, for a hang-up) stores the
//      recording's sid on phone_user_settings and deletes the one it replaced at Twilio. `t`, the
//      moment the ring was placed, rides on every URL of the ring: a recording never replaces a
//      greeting recorded or cleared after its own ring began (a late callback can't undo either);
//   4. a voicemail that is that person's plays it (../voicemail.ts) through GET
//      /voice/greeting-audio, which streams the stored recording from Twilio.
// NO UPLOAD, on purpose: browsers record webm/opus and phones m4a, and <Play> takes neither.
//
// THE RING IS NOT A CALL. It has no phone_calls row, so nothing lists it, bills it to the
// builder (the usage charges read phone_calls), or files its recording as a voicemail: the sweep
// files <Record> recordings only on INBOUND calls to our numbers (cron/sweep.ts), and this one is
// a REST call the Worker placed (outbound-api).
//
// GET /voice/greeting-audio is the one Twilio path that is a GET: <Play> fetches its URL with a
// GET and no signature to check. So it has its own lock: ?key= (the webhook secret, compared in
// constant time), and it streams only the sid stored for that person (`v` must equal it), so a
// replaced or cleared greeting is never played again and a guessed sid plays nothing. `v` is also
// what keeps Twilio's <Play> cache honest: a new recording is a new URL.

import type { Ctx, Env } from "./env";
import { adminClient, callerContext, type Admin } from "./db";
import { safeEqual, UUID_RE } from "./http";
import { logFault } from "./log";
import type { TwilioParams } from "./twilioSignature";
import { hangup, record, response, say } from "./twiml";
import { deleteRecording, recordingMedia } from "./twilioRest";
import { hook } from "./urls";

/** A Twilio recording sid as migration 264's check has it (lowercase hex, as Twilio writes them). */
export const GREETING_SID_RE = /^RE[0-9a-f]{32}$/;
/** The longest greeting (seconds). */
export const GREETING_MAX_SECONDS = 60;
/** Shorter than this is a hang-up at the beep or a cough, not a greeting: nothing is kept. */
export const MIN_GREETING_SECONDS = 2;
/** How long the person's app rings for the recording call. */
export const GREETING_RING_SECONDS = 25;
/** The custom parameter on the ring (phone-core greeting.ts isGreetingRing reads it). */
export const GREETING_PURPOSE = "greeting";

export const GREETING_SAY = {
  ask: "After the tone, say the greeting your callers will hear. Press pound when you're done.",
  saved: "Your greeting is saved. Goodbye.",
  tooShort: "That was too short. Please try again.",
  nothing: "We didn't hear a greeting. Please try again.",
  failed: "Your greeting couldn't be saved. Please try again.",
  newer: "A newer greeting is already saved. Goodbye.",
} as const;

/**
 * Where Twilio fetches one person's greeting from: our own GET path, the recording's sid as `v`
 * (the version: a new recording is a new URL, so Twilio's media cache can't play an old one).
 */
export function greetingAudioUrl(env: Env, userId: string, sid: string): string {
  return hook(env, "/voice/greeting-audio", { u: userId, v: sid });
}

// ── /voice/greeting ─────────────────────────────────────────────────────────────────

/** The <Record> that takes the greeting. Its status callback saves it too, if the person hangs up. */
function recordVerb(env: Env, userId: string, ringAt: number): string {
  return record({
    action: hook(env, "/voice/greeting", { user: userId, t: ringAt, stage: "saved" }),
    recordingStatusCallback: hook(env, "/voice/greeting", { user: userId, t: ringAt, stage: "saved", cb: "status" }),
    maxLength: GREETING_MAX_SECONDS,
  });
}

/** The ring's start (`t`, epoch ms) from our own URL, or null when it isn't one. */
function ringTime(url: URL): number | null {
  const t = Number(url.searchParams.get("t") ?? "");
  return Number.isSafeInteger(t) && t > 0 ? t : null;
}

export type SaveOutcome = "saved" | "newer" | "no_access" | "failed";

/**
 * Store `sid` as the person's greeting and delete the one it replaced at Twilio (after the
 * answer). Compare-and-swap on the old value: the <Record> action and its status callback both
 * arrive for one recording, and whichever is second finds the sid already stored and changes
 * nothing, so neither can delete the other's work. A greeting recorded or cleared after this
 * recording's ring began (`ringAt`, against greeting_updated_at) is newer and is kept ("newer"):
 * a late callback can't bring back a greeting the person replaced or deleted since. Someone who
 * no longer has phone access gets nothing stored. A database failure is "failed", never thrown:
 * the caller is on the line.
 */
export async function saveGreeting(env: Env, ec: Ctx, admin: Admin, userId: string, sid: string, ringAt: number): Promise<SaveOutcome> {
  try {
    const ctx = await callerContext(admin, userId);
    if (!ctx || ctx.phone_level === "none") return "no_access";
    for (let attempt = 0; attempt < 3; attempt++) {
      const { data, error } = await admin.from("phone_user_settings").select("greeting_recording_sid, greeting_updated_at").eq("user_id", userId).maybeSingle();
      if (error) throw new Error(error.message);
      const row = data as { greeting_recording_sid?: string | null; greeting_updated_at?: string | null } | null;
      const prev = row?.greeting_recording_sid ?? null;
      if (prev === sid) return "saved";
      // Recorded or cleared ("Use the standard greeting") since this ring began: that choice is newer.
      const savedAt = row?.greeting_updated_at ? Date.parse(row.greeting_updated_at) : NaN;
      if (Number.isFinite(savedAt) && savedAt > ringAt) return "newer";
      const now = new Date().toISOString();
      const fields = { greeting_recording_sid: sid, greeting_updated_at: now, updated_at: now };
      let won: boolean;
      if (!data) {
        // No settings row yet: a duplicate key means one appeared meanwhile; go round and swap it.
        const ins = await admin.from("phone_user_settings").insert({ user_id: userId, client_id: ctx.client_id, ...fields });
        won = !ins.error;
      } else {
        let q = admin.from("phone_user_settings").update(fields).eq("user_id", userId);
        q = prev ? q.eq("greeting_recording_sid", prev) : q.is("greeting_recording_sid", null);
        const upd = await q.select("user_id");
        if (upd.error) throw new Error(upd.error.message);
        won = Array.isArray(upd.data) && upd.data.length > 0;
      }
      if (!won) continue;
      if (prev) ec.waitUntil(dropRecording(env, prev, ctx.client_id, "replaced"));
      return "saved";
    }
    throw new Error("the greeting changed under every attempt");
  } catch (e) {
    // The sid, so a recording that really is unsaved can be deleted by hand (voiceGreeting
    // doesn't delete on "failed": see there).
    await logFault({ code: "greeting_save_failed", message: `Saving a voicemail greeting failed: ${(e as Error).message}`, context: { userId, recording: sid } });
    return "failed";
  }
}

/** Delete a greeting recording at Twilio. A failure is logged (with the sid, to delete by hand). */
export async function dropRecording(env: Env, sid: string, clientId: string | null, why: string): Promise<void> {
  try {
    await deleteRecording(env, sid);
  } catch (e) {
    await logFault({
      code: "greeting_delete_failed", severity: "warn", clientId,
      message: `A ${why} voicemail greeting couldn't be deleted at Twilio: ${(e as Error).message}`,
      context: { recording: sid },
    });
  }
}

/**
 * /voice/greeting: the answer URL and the callbacks of the recording ring. Null means 204.
 *   stage=ask    the person answered: what to do, then <Record>;
 *   stage=saved  the <Record> action (TwiML) or, with cb=status, its status callback (204);
 *   stage=status the ring's own status callback (204: nothing is kept about the ring).
 * `user` is in our own URL, which Twilio signed (or carried ?key= on); never a caller's input.
 */
export async function voiceGreeting(env: Env, ec: Ctx, p: TwilioParams, url: URL): Promise<string | null> {
  const stage = url.searchParams.get("stage") ?? "";
  const isStatus = stage === "status" || url.searchParams.get("cb") === "status";
  if (stage === "status") return null;
  const userId = url.searchParams.get("user") ?? "";
  if (!UUID_RE.test(userId)) {
    ec.waitUntil(logFault({ code: "greeting_no_user", message: "/voice/greeting reached without a user id." }));
    return isStatus ? null : response(say(GREETING_SAY.failed), hangup());
  }
  const ringAt = ringTime(url);
  if (ringAt === null) {
    ec.waitUntil(logFault({ code: "greeting_no_ring_time", message: "/voice/greeting reached without the ring's time." }));
    return isStatus ? null : response(say(GREETING_SAY.failed), hangup());
  }
  if (stage === "ask") {
    // Nothing recorded (silence until the timeout) skips the action and lands on the last two.
    return response(say(GREETING_SAY.ask), recordVerb(env, userId, ringAt), say(GREETING_SAY.nothing), hangup());
  }
  if (stage !== "saved") return isStatus ? null : response(hangup());

  const sid = String(p.RecordingSid ?? "");
  const seconds = Number.parseInt(String(p.RecordingDuration ?? ""), 10);
  if (!GREETING_SID_RE.test(sid) || (isStatus && p.RecordingStatus !== "completed")) {
    return isStatus ? null : response(say(GREETING_SAY.failed), hangup());
  }
  if (!(seconds >= MIN_GREETING_SECONDS)) {
    // Nothing is kept, at Twilio either.
    ec.waitUntil(dropRecording(env, sid, null, "too short"));
    return isStatus ? null : response(say(GREETING_SAY.tooShort), hangup());
  }
  const outcome = await saveGreeting(env, ec, adminClient(env), userId, sid, ringAt);
  // NEVER DELETE ON "failed". The action and the status callback both save this one recording, and
  // a failure here says nothing about what the other one did: if it stored this sid a moment ago,
  // deleting it at Twilio would leave the person's greeting pointing at nothing, and their callers
  // hearing a bare beep, until they noticed and recorded again. The other callback (or the next
  // recording, which replaces it) settles it; a recording neither stores is a logged orphan
  // (greeting_save_failed carries its sid). "newer" is never the stored sid (saveGreeting checks).
  if (outcome === "newer" || outcome === "no_access") ec.waitUntil(dropRecording(env, sid, null, outcome === "newer" ? "superseded" : "refused"));
  if (isStatus) return null;
  return response(say(outcome === "saved" ? GREETING_SAY.saved : outcome === "newer" ? GREETING_SAY.newer : GREETING_SAY.failed), hangup());
}

// ── GET /voice/greeting-audio ───────────────────────────────────────────────────────

/**
 * <Play>'s fetch of one person's greeting: ?u=<user>&v=<recording sid>&key=<webhook secret>.
 * 403 on a wrong key, 404 unless `v` is the sid stored for `u` right now, else the audio, streamed
 * from Twilio (a failed fetch makes Twilio skip the <Play>: the caller hears the beep and can
 * still leave a message). GET or HEAD only.
 */
export async function greetingAudio(req: Request, env: Env, ec: Ctx): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  const secret = env.PHONE_WEBHOOK_SECRET || "";
  if (!secret) {
    ec.waitUntil(logFault({
      code: "twilio_no_webhook_secret", req, throttleMs: 5 * 60_000,
      message: "Refusing every Twilio request: PHONE_WEBHOOK_SECRET is not set.",
    }));
    return new Response("Service unavailable", { status: 503 });
  }
  const url = new URL(req.url);
  if (!safeEqual(url.searchParams.get("key") ?? "", secret)) {
    ec.waitUntil(logFault({
      code: "twilio_bad_key", severity: "info", req, throttleMs: 60_000,
      message: "Refused a greeting audio request (bad_key) on /voice/greeting-audio.",
    }));
    return new Response("Forbidden", { status: 403 });
  }
  const notFound = () => new Response("Not found", { status: 404 });
  const userId = url.searchParams.get("u") ?? "";
  const sid = url.searchParams.get("v") ?? "";
  if (!UUID_RE.test(userId) || !GREETING_SID_RE.test(sid)) return notFound();
  const { data, error } = await adminClient(env).from("phone_user_settings").select("greeting_recording_sid").eq("user_id", userId).maybeSingle();
  if (error) throw new Error(`read greeting: ${error.message}`);
  if ((data as { greeting_recording_sid?: string | null } | null)?.greeting_recording_sid !== sid) return notFound();

  let media: Response;
  try {
    media = await recordingMedia(env, sid, req.headers.get("range"));
  } catch {
    return new Response("Bad gateway", { status: 502 });
  }
  if (media.status === 404) return notFound();
  if (!media.ok) return new Response("Bad gateway", { status: 502 });
  const headers = new Headers({
    "content-type": "audio/mpeg",
    // The URL names one recording (`v`), so a cached copy is never a stale greeting.
    "cache-control": "max-age=3600",
    "accept-ranges": "bytes",
  });
  for (const h of ["content-length", "content-range"]) {
    const v = media.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new Response(req.method === "HEAD" ? null : media.body, { status: media.status, headers });
}
