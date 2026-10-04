// The voicemail TwiML: a greeting, then <Record>.
//
// Its own module because four callers build it: inbound and after-dial (routes/voice.ts), a
// cold transfer to a teammate who is away (routes/calls.ts), and a customer left alone in a
// conference (conference.ts).
//
// WHICH GREETING (migration 264), first that applies:
//   1. the person's own, recorded by phone (../greeting.ts), when the voicemail is theirs: a call
//      transferred to them (the transfer passes them), or a line that is only theirs, a route
//      whose answer list is exactly one person with phone access (lineOwner, the default);
//   2. the number's, the owner's link (phone_routes.greeting_url);
//   3. the standard sentence (greetingText).
// A shared number (two or more on the answer list) never plays one person's greeting: the
// caller didn't ring them. When per-person numbers land, their owner field replaces lineOwner.
//
// TRANSCRIPTION (release 2) is behind env TRANSCRIBE=on: <Record transcribe="true"> with a
// transcribeCallback to /voice/transcription, which stores phone_voicemails.transcript.
// Twilio only transcribes English recordings of 2 seconds to 2 minutes; a longer message is
// still recorded, it just gets no text (the callback reports `failed`).

import type { Env } from "./env";
import type { RouteInfo } from "./db";
import { GREETING_SID_RE, greetingAudioUrl } from "./greeting";
import { hangup, play, record, response, say } from "./twiml";
import { hook } from "./urls";

/** Whose voicemail this is: the person, and their own greeting's recording sid (null: none). */
export interface VoicemailFor {
  user_id: string;
  greeting_sid: string | null;
}

export function greetingText(business: string | null): string {
  const who = (business ?? "").trim();
  return `${who ? `You've reached ${who}.` : "Thanks for calling."} We can't take your call right now. `
    + "Please leave your name, number and a short message after the tone.";
}

/** Exactly "on" (any case, trimmed) switches transcription on. */
export function transcribeOn(env: Env): boolean {
  return String(env.TRANSCRIBE ?? "").trim().toLowerCase() === "on";
}

/**
 * The person a line belongs to: the one member of a route whose answer list is exactly them, while
 * they have phone access on the number's business. Null for a shared number (or none at all).
 */
export function lineOwner(info: RouteInfo | null): VoicemailFor | null {
  if (!info || info.route.members.length !== 1) return null;
  const m = info.members.find((x) => x.user_id === info.route.members[0] && !x.cover_only);
  return m && m.has_access ? { user_id: m.user_id, greeting_sid: m.greeting_sid ?? null } : null;
}

/**
 * The greeting, then record. `forUser` is whose voicemail it is: by default the line's owner
 * (lineOwner); a transfer passes the teammate it was for, and null means nobody's in particular.
 * Their own greeting plays when they have one, else the number's, else the standard one.
 */
export function voicemailTwiml(env: Env, callId: string, info: RouteInfo | null, forUser: VoicemailFor | null = lineOwner(info)): string {
  const own = forUser && forUser.greeting_sid && GREETING_SID_RE.test(forUser.greeting_sid) ? forUser.greeting_sid : null;
  const greeting = own
    ? play(greetingAudioUrl(env, forUser!.user_id, own))
    : info?.route.greeting_url ? play(info.route.greeting_url) : say(greetingText(info?.business_name ?? null));
  return response(
    greeting,
    record({
      action: hook(env, "/voice/voicemail", { call: callId }),
      recordingStatusCallback: hook(env, "/voice/voicemail", { call: callId, cb: "status" }),
      transcribeCallback: transcribeOn(env) ? hook(env, "/voice/transcription", { call: callId }) : undefined,
    }),
    hangup(),
  );
}
