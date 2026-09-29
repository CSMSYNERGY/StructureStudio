// Hold and warm transfer: plan section 9C, DESIGN (b). Keep the plain <Dial>; move a call
// into a <Conference> only when someone presses Hold or Warm transfer.
//
// ── THE MOVE ────────────────────────────────────────────────────────────────────────────
// A live call is one plain Dial with a PARENT leg and a dialed CHILD leg:
//   inbound, and any call a cold transfer handed on   parent = customer, child = our person
//   outbound, never handed on                         parent = our app,  child = customer
// Every such Dial carries an action URL (/voice/after-dial; outbound ones with stage=out).
// To move the call:
//   1. transfer_state goes null → 'conference', conditionally, so two presses cannot both win;
//   2. the CHILD is redirected (REST) into <Conference> named after the phone_calls id;
//   3. the child leaving ends the parent's Dial, Twilio requests that Dial's action URL, and
//      after-dial sees transfer_state = 'conference' and answers the PARENT with the same
//      <Conference>. Nobody is dropped, nobody is sent to voicemail.
// Redirecting the parent instead would tear the bridge down and hang the child up. Once a call
// is in its conference it stays there until it ends; there is no way back to a plain Dial,
// and none is needed (a cold transfer from a conference redirects the customer, which ends it).
//
// ── WHO JOINS HOW ───────────────────────────────────────────────────────────────────────
//   customer  startConferenceOnEnter=false, endConferenceOnExit=true, and Twilio's default
//             hold music until somebody starts the conference. The customer leaving ends it.
//   agent     (whoever holds the call for us) start=false, end=false, silence while waiting.
//             So a call that has just been moved is ON HOLD: the conference has not started,
//             the customer hears music and the two are not connected ("muted out").
//   teammate  (warm transfer, added with the Participants API) start=true, end=false: when
//             they answer, the conference starts and everyone WAITING in it is connected.
//             From a plain call (just moved: the customer waits on music) that means all three
//             talk. From a call already on hold, the customer is first held through the
//             Participants API (routes/conference.ts keepCustomerHeld), because a customer who
//             is only waiting would otherwise be connected into the private consult.
//
// ── HOLD / RESUME ───────────────────────────────────────────────────────────────────────
//   hold     from a plain Dial: the move above, nothing else. In a conference that has
//            started: Participants API Hold=true on the customer (HoldUrl = the same music).
//   resume   a conference that has not started: take the customer off a Participants hold if
//            a warm transfer put one on, then redirect the agent's leg back in with
//            startConferenceOnEnter=true, which starts it. A started one: Hold=false.
//
// ── NOBODY IS LEFT ALONE ────────────────────────────────────────────────────────────────
// Every <Conference> and every added participant reports `leave`. When someone other than the
// customer hangs up (a leg that was only redirected is still live, and is ignored) and the
// customer is the only one left, the customer is finished: voicemail if they were waiting (on
// hold, or never connected), hung up if they were talking. The leg that holds the call for us
// ending (its own status callback) is a second trigger for the same check, so a leave event
// that was skipped or failed cannot strand the customer. A teammate who never answers a warm
// transfer is handled the same way from their leg's status callback, always voicemail.
//
// ── HANDED OVER ON HOLD ─────────────────────────────────────────────────────────────────
// SPEC: the one who warm-transfers hanging up leaves the customer with the teammate. When the
// customer is on hold and the only other person left is the teammate who took the call, the
// customer comes off hold: when the transferrer leaves mid-consult, or when the teammate
// answers after the transferrer has already gone. Otherwise the two would sit in music and
// silence, and the teammate's app, which never pressed Hold, has no Resume to offer.

import type { Env } from "./env";
import {
  addCallEvent, adminClient, callById, patchCall, routeForNumber, type Admin, type CallRow, type RouteInfo,
} from "./db";
import { ApiError, UUID_RE } from "./http";
import { parseIdentity, stripClientPrefix } from "./identity";
import { logFault } from "./log";
import type { TwilioParams } from "./twilioSignature";
import {
  fetchCall, fetchConference, findConference, listParticipants, updateCall, updateParticipant, type TwilioParticipant,
} from "./twilioRest";
import { conference, response } from "./twiml";
import { hook } from "./urls";
import { voicemailTwiml } from "./voicemail";

/** Twilio's default conference hold music (the documented default waitUrl), used as HoldUrl. */
export const HOLD_MUSIC = "https://twimlets.com/holdmusic?Bucket=com.twilio.music.classical";

/** Conference events we ask for, in TwiML's spelling. Only a participant leaving matters. */
export const CONFERENCE_EVENTS = "leave";

export type Role = "customer" | "agent";

const TERMINAL = new Set(["completed", "busy", "no-answer", "failed", "canceled"]);

/** A Twilio call status that means the leg has ended. */
export function isTerminal(status: string): boolean {
  return TERMINAL.has(status);
}

// ── TwiML ───────────────────────────────────────────────────────────────────────────────

/**
 * One leg's way into the call's conference. The agent joins waiting (start=false) unless
 * `start`, which only resume uses.
 */
export function conferenceTwiml(env: Env, callId: string, role: Role, start = false): string {
  const statusCallback = hook(env, "/voice/conference", { call: callId });
  return response(role === "customer"
    ? conference({
      name: callId, startConferenceOnEnter: false, endConferenceOnExit: true,
      statusCallback, statusCallbackEvent: CONFERENCE_EVENTS,
    })
    : conference({
      name: callId, startConferenceOnEnter: start, endConferenceOnExit: false, waitUrl: "",
      statusCallback, statusCallbackEvent: CONFERENCE_EVENTS,
    }));
}

// ── Legs ────────────────────────────────────────────────────────────────────────────────

export interface Legs {
  /** The customer's leg (twilio_call_sid). */
  customer: string | null;
  /** Whoever holds the call for us now (client_call_sid). */
  agent: string | null;
  /** The leg the live plain Dial dialed: the one a move redirects. */
  child: string | null;
  childRole: Role;
}

/**
 * Which leg is which. An outbound call's customer is the CHILD of the app's Dial until a cold
 * transfer redirects it into a Dial of its own, after which it is the parent like an inbound
 * customer. `transferred_from` is set by exactly that (and by a warm transfer, which only
 * happens in a conference, where no move is needed).
 */
export function legsOf(call: Pick<CallRow, "direction" | "twilio_call_sid" | "client_call_sid" | "transferred_from">): Legs {
  const customerIsParent = call.direction === "in" || !!call.transferred_from;
  return {
    customer: call.twilio_call_sid,
    agent: call.client_call_sid,
    child: customerIsParent ? call.client_call_sid : call.twilio_call_sid,
    childRole: customerIsParent ? "agent" : "customer",
  };
}

/**
 * Is this person on the call (may they hold, resume or transfer it)? The one who answered, the
 * one who placed an outbound call not yet handed on, and, while the call is in its conference,
 * the one who handed it on by warm transfer (they may still be in it, consulting).
 */
export function onTheCall(userId: string, call: Pick<CallRow, "answered_by" | "direction" | "placed_by" | "transferred_from" | "transfer_state">): boolean {
  return call.answered_by === userId
    || (call.direction === "out" && call.placed_by === userId && !call.transferred_from)
    || (call.transfer_state === "conference" && call.transferred_from === userId);
}

// ── The 911 callback window ─────────────────────────────────────────────────────────────

export const EMERGENCY_CALLBACK = "For an hour after a 911 call from this number, its calls can't be put on hold or transferred.";

/**
 * Plan section 14: for 60 minutes after a 911 call from a number, an inbound call to it (the
 * dispatcher calling back) rings only the person who dialed 911 and never goes to voicemail.
 * Hold, warm and cold transfer can each end in the builder's voicemail (a customer left alone
 * in the conference, a teammate on DND), so none of them is offered on those calls. Resume is
 * never refused. Pass `info` when the route has been read already.
 */
export async function refuseEmergencyCallback(admin: Admin, call: Pick<CallRow, "direction" | "to_e164">, info?: RouteInfo | null): Promise<void> {
  if (call.direction !== "in") return;
  const route = info !== undefined ? info : await routeForNumber(admin, call.to_e164);
  if (route?.recent_emergency_user) throw new ApiError("bad_request", EMERGENCY_CALLBACK);
}

// ── The state machine ───────────────────────────────────────────────────────────────────

export type TransferState = CallRow["transfer_state"];
export type CallAction = "cold" | "hold" | "resume" | "warm";

export type Step =
  | { ok: true; next: "transferring" | "conference"; move: boolean }
  | { ok: false; message: string };

/**
 * transfer_state transitions for the four things a person can do to a live call.
 *   null          → cold: 'transferring'   hold / warm: 'conference', moving the call first
 *   'conference'  → cold: 'transferring'   hold / warm / resume: stays, no move
 *   'transferring'→ nothing: a cold transfer is ringing the teammate; wait for it
 * Cleared (→ null) by the Twilio side only: a teammate answering a cold transfer, voicemail,
 * the customer's leg ending, or a customer left alone in the conference.
 */
export function nextTransferState(current: TransferState, action: CallAction): Step {
  if (current === "transferring") {
    return { ok: false, message: action === "cold" ? "A transfer is already under way." : "A transfer is under way. Wait for it to finish." };
  }
  switch (action) {
    case "cold":
      return { ok: true, next: "transferring", move: false };
    case "hold":
    case "warm":
      return { ok: true, next: "conference", move: current === null };
    case "resume":
      if (current !== "conference") return { ok: false, message: "That call isn't on hold." };
      return { ok: true, next: "conference", move: false };
  }
}

// ── Finishing a customer left alone ─────────────────────────────────────────────────────

export type FinishOutcome = "voicemail" | "hung_up" | "handed_over" | "not_alone" | "no_customer" | "lost_race";

/** The participants still in the call (a leg that has left is `complete` or gone). */
function stillIn(parts: TwilioParticipant[]): TwilioParticipant[] {
  return parts.filter((p) => p.status !== "complete" && p.status !== "failed");
}

/** Take the customer off hold for the teammate who now has the call (HANDED OVER ON HOLD). */
async function handOver(env: Env, admin: Admin, row: CallRow, conferenceSid: string, customer: string): Promise<"handed_over"> {
  await updateParticipant(env, conferenceSid, customer, { Hold: "false" });
  await addCallEvent(admin, row.id, "handed_over", { to: row.answered_by });
  return "handed_over";
}

/**
 * Someone other than the customer has left the conference; look at who is left. `gone` is the
 * leg known to have ended, left out even if Twilio's list still shows it.
 *   - only the customer: finish them. `prefer` "voicemail" always leaves a message (a warm
 *     transfer nobody took); "auto" leaves one only if they were waiting (held, or the
 *     conference never started) and otherwise hangs up, as any call ends when the other side
 *     hangs up.
 *   - the customer on hold and only the person who now holds the call (client_call_sid,
 *     moved there when they answered a warm transfer): the transferrer has hung up mid-consult,
 *     so the customer comes off hold ("auto" only).
 */
export async function finishIfAlone(env: Env, admin: Admin, row: CallRow, conferenceSid: string, prefer: "voicemail" | "auto", gone?: string): Promise<FinishOutcome> {
  const customer = row.twilio_call_sid;
  if (!customer) return "no_customer";
  const [parts, conf] = await Promise.all([listParticipants(env, conferenceSid), fetchConference(env, conferenceSid)]);
  const left = stillIn(parts).filter((p) => p.call_sid !== gone);
  const me = left.find((p) => p.call_sid === customer);
  if (!me) return "not_alone";
  const others = left.filter((p) => p.call_sid !== customer);
  if (prefer === "auto" && me.hold === true && others.length === 1 && others[0].call_sid === row.client_call_sid) {
    return handOver(env, admin, row, conferenceSid, customer);
  }
  if (others.length) return "not_alone";
  const waiting = prefer === "voicemail" || me.hold === true || conf?.status === "init";

  // The claim: out of the conference state first, conditionally, so two leave events that
  // both see the customer alone cannot both redirect them (the second would restart the
  // greeting). after-dial and later conference events then treat the call as a plain one.
  const claimed = await patchCall(admin, row.id, { transfer_state: null }, (q) => q.eq("transfer_state", "conference"));
  if (!claimed) return "lost_race";

  try {
    if (waiting) {
      const info = await routeForNumber(admin, row.direction === "in" ? row.to_e164 : row.from_e164);
      await updateCall(env, customer, { Twiml: voicemailTwiml(env, row.id, info) });
      await addCallEvent(admin, row.id, "conference_voicemail", { prefer });
      return "voicemail";
    }
    await updateCall(env, customer, { Status: "completed" });
  } catch (e) {
    // The customer is still in the conference: say so on the row, and let the caller log it.
    await patchCall(admin, row.id, { transfer_state: "conference" }, (q) => q.is("transfer_state", null));
    throw e;
  }
  await addCallEvent(admin, row.id, "conference_ended", null);
  return "hung_up";
}

// ── /voice/conference (Twilio's conference status callback) ─────────────────────────────

/** Runs in waitUntil after the 204. */
export async function conferenceEvent(env: Env, p: TwilioParams, url: URL): Promise<FinishOutcome | "ignored"> {
  const callId = url.searchParams.get("call") ?? "";
  if (!UUID_RE.test(callId) || p.StatusCallbackEvent !== "participant-leave") return "ignored";
  const conferenceSid = String(p.ConferenceSid ?? "");
  const leaving = String(p.CallSid ?? "");
  if (!conferenceSid || !leaving) return "ignored";

  const admin = adminClient(env);
  const row = await callById(admin, callId);
  if (!row || row.transfer_state !== "conference" || row.ended_at) return "ignored";
  // The customer leaving ends the conference by itself (endConferenceOnExit), and their own
  // status callback closes the row.
  if (!row.twilio_call_sid || leaving === row.twilio_call_sid) return "ignored";

  // A leg that was only REDIRECTED (resume re-joins the agent with start=true) leaves and
  // comes straight back: it is still live. Only a leg that has really ended counts. If Twilio
  // has not marked a real hang-up ended yet, the leg's own status callback catches it
  // (holderLegEnded) when it is the one holding the call.
  const gone = await fetchCall(env, leaving);
  if (gone && !TERMINAL.has(gone.status)) return "ignored";
  return finishIfAlone(env, admin, row, conferenceSid, "auto", leaving);
}

// ── The holder's leg ended (/voice/status) ──────────────────────────────────────────────

/**
 * The leg that holds the call for us (client_call_sid: the agent, a cold-transfer teammate,
 * or the teammate who answered a warm transfer) reports a final status while the call is in
 * its conference. Its own status callback is proof it has ended, so this is the second
 * trigger beside the leave event: whichever sees the customer alone first finishes them, and
 * finishIfAlone's conditional claim stops the other. Runs in waitUntil from /voice/status.
 * Accepted on ?key= alone (`signed` false), the callback proves nothing, so Twilio must agree
 * that the leg has ended: a forged one must not hang up a customer who is still talking.
 */
export async function holderLegEnded(env: Env, row: CallRow, sid: string, signed = true): Promise<FinishOutcome | "ignored"> {
  if (!signed) {
    const leg = await fetchCall(env, sid);
    if (leg && !TERMINAL.has(leg.status)) return "ignored";
  }
  const conf = await findConference(env, row.id);
  if (!conf) return "ignored";
  return finishIfAlone(env, adminClient(env), row, conf.sid, "auto", sid);
}

// ── The warm-transfer teammate's leg (/voice/status?leg=warm) ────────────────────────────

interface Room {
  sid: string;
  parts: TwilioParticipant[];
}

/** The call's live conference and who is in it, or null when there is none. */
async function roomOf(env: Env, callId: string): Promise<Room | null> {
  const conf = await findConference(env, callId);
  return conf ? { sid: conf.sid, parts: await listParticipants(env, conf.sid) } : null;
}

/**
 * Status of the teammate's leg a warm transfer dialed into the conference. Runs in waitUntil
 * after the generic status event has been recorded.
 *   answered   they now hold the call: answered_by moves to them, transferred_from keeps
 *              who handed it on, client_call_sid becomes their leg. If the call has already
 *              left its conference (ended, or cold-transferred meanwhile), they are hung up
 *              instead of being left in an empty conference. If the one who handed it on has
 *              already gone and the customer is on hold, the customer comes off hold.
 *   unanswered (no-answer, busy, failed, canceled): if the customer is now alone, voicemail.
 *   completed  after answering: the conference's leave event, or /voice/status's
 *              holderLegEnded (their leg is client_call_sid by then).
 *
 * `signed` is false when the request was accepted on ?key= alone (TWILIO_AUTH_TOKEN unset,
 * DEVIATIONS 30). The `user` in the URL is then no proof of anything, and it decides who may
 * hold and transfer the call, so the answer only counts when Twilio's own records agree: the
 * leg is live, it rang that user's identity, and it is in this call's conference.
 */
export async function warmLegStatus(env: Env, row: CallRow, p: TwilioParams, url: URL, signed = true): Promise<void> {
  const admin = adminClient(env);
  const status = String(p.CallStatus ?? "");
  const sid = String(p.CallSid ?? "");
  const user = url.searchParams.get("user") ?? "";

  if (status === "in-progress" || status === "answered") {
    if (row.transfer_state !== "conference" || row.ended_at) {
      if (sid) await updateCall(env, sid, { Status: "completed" }).catch(() => {});
      return;
    }
    if (!UUID_RE.test(user) || !sid) return;
    let room: Room | null | undefined;
    if (!signed) {
      room = await roomOf(env, row.id);
      const leg = await fetchCall(env, sid);
      const rang = leg ? parseIdentity(stripClientPrefix(String(leg.to ?? "")).split("?")[0]) : null;
      if (!leg || leg.status !== "in-progress" || rang?.userId !== user || !room?.parts.some((x) => x.call_sid === sid)) {
        await logFault({
          code: "warm_answer_unverified", severity: "warn", clientId: row.client_id,
          message: "An unsigned warm-transfer answer did not match Twilio's records; the call was not handed over.",
          context: { callId: row.id },
        });
        return;
      }
    }
    const moved = await patchCall(admin, row.id, {
      answered_by: user,
      transferred_from: row.answered_by ?? row.placed_by,
      client_call_sid: sid,
    }, (q) => q.eq("transfer_state", "conference"));
    if (!moved) return;
    try {
      room ??= await roomOf(env, row.id);
      const customer = row.twilio_call_sid;
      const me = room?.parts.find((x) => x.call_sid === customer);
      const others = room ? stillIn(room.parts).filter((x) => x.call_sid !== customer && x.call_sid !== sid) : [];
      if (room && customer && me?.hold === true && !others.length) {
        await handOver(env, admin, { ...row, answered_by: user, client_call_sid: sid }, room.sid, customer);
      }
    } catch (e) {
      await logFault({ code: "warm_handover_failed", clientId: row.client_id, message: (e as Error).message, context: { callId: row.id } });
    }
    return;
  }
  if (!TERMINAL.has(status) || status === "completed") return;
  if (row.transfer_state !== "conference" || row.ended_at) return;
  await addCallEvent(admin, row.id, "warm_transfer_missed", { user: UUID_RE.test(user) ? user : null, status });
  try {
    const conf = await findConference(env, row.id);
    if (conf) await finishIfAlone(env, admin, row, conf.sid, "voicemail");
  } catch (e) {
    await logFault({ code: "warm_transfer_finish_failed", clientId: row.client_id, message: (e as Error).message, context: { callId: row.id } });
  }
}
