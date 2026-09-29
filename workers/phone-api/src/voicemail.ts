// The voicemail TwiML: the builder's greeting (or the standard one), then <Record>.
//
// Its own module because four callers build it: inbound and after-dial (routes/voice.ts), a
// cold transfer to a teammate on DND (routes/calls.ts), and a customer left alone in a
// conference (conference.ts). routes/voice.ts re-exports both names.
//
// TRANSCRIPTION (release 2) is behind env TRANSCRIBE=on: <Record transcribe="true"> with a
// transcribeCallback to /voice/transcription, which stores phone_voicemails.transcript.
// Twilio only transcribes English recordings of 2 seconds to 2 minutes; a longer message is
// still recorded, it just gets no text (the callback reports `failed`).

import type { Env } from "./env";
import type { RouteInfo } from "./db";
import { hangup, play, record, response, say } from "./twiml";
import { hook } from "./urls";

export function greetingText(business: string | null): string {
  const who = (business ?? "").trim();
  return `${who ? `You've reached ${who}.` : "Thanks for calling."} We can't take your call right now. `
    + "Please leave your name, number and a short message after the tone.";
}

/** Exactly "on" (any case, trimmed) switches transcription on. */
export function transcribeOn(env: Env): boolean {
  return String(env.TRANSCRIBE ?? "").trim().toLowerCase() === "on";
}

/** The standard greeting (or the builder's recording), then record. */
export function voicemailTwiml(env: Env, callId: string, info: RouteInfo | null): string {
  const greeting = info?.route.greeting_url ? play(info.route.greeting_url) : say(greetingText(info?.business_name ?? null));
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
