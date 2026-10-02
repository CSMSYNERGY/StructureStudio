// Moving a live call between the person's own devices: "Move to phone" on the Chrome extension,
// "Move to computer" on the phone app (plan Part 2, 2026-10-02; migration 260). The app
// endpoints are in routes/handoff.ts; this file is the Twilio side and what both share.
//
// ── RING FIRST, TOUCH THE CALL ONLY AFTER THE ANSWER ────────────────────────────────────
// Until the other device answers, nothing about the call changes: the customer stays with the
// device they are on, talking or on hold, and a ring nobody answers leaves everything as it was.
// The claim (routes/handoff.ts) writes handoff_state = 'ringing' with a fresh one-time key.
//   computer → phone   a Twilio ring. The Worker calls the person's own identity over REST (25 s)
//                      with handoff=1 and the call's details as custom parameters on the client
//                      address (Twilio delivers a query string on a REST `To` of client:<id> to
//                      the SDK's CallInvite customParameters), so the phone shows its native
//                      full-screen ring, even locked. The extension, still on the call, never
//                      takes it: the Voice SDK with allowIncomingWhileBusy off drops an invite
//                      while busy, and the extension ignores (never rejects) one that carries
//                      handoff parameters. Its answer URL is /voice/handoff.
//   phone → computer   a Realtime ring. The phone's SDK rings out loud before its JS can ignore
//                      an invite, so no Twilio ring can reach the person's identity while the
//                      phone is on the call. The claim's row update is the signal: it broadcasts
//                      on phone:user:<them> (migration 254 PART 7, ids only), the extension reads
//                      GET /handoff/pending and rings by itself. Answering is
//                      device.connect({To:'handoff', HandoffCall, HandoffKey}), which reaches
//                      /voice/outbound and is answered there BEFORE every outbound-call rule: no
//                      new phone_calls row, no daily minute cap, no wallet floor.
// Both answers land in handoffAnswer.
//
// ── THE ANSWER, THEN MAKE BEFORE BREAK ──────────────────────────────────────────────────
// handoffAnswer: one guarded update, ringing → connecting, with the key, within 45 s of the
// ring, on a live call still held by the leg the move started from. On a plain call (no
// conference yet) the SAME update claims the conference (transfer_state → 'conference': THE MOVE
// step 1 in conference.ts), so a second answer, Hold or a transfer cannot slip in between. The
// new leg is answered with the call's conference as the agent: start=true on a plain call (it
// starts when the customer arrives), start=false on one already in its conference, so a held
// customer stays held and a started conference just gains a member. A lost claim gets "That
// call has already moved or ended." and a hang-up. Then completeHandoff, in waitUntil:
//   0. an OUTBOUND plain call's customer is the CHILD of the old leg's Dial, so the old device
//      hanging up (the person ending the call there once the other device has answered, or an
//      iPhone's side button) would take the customer down with it. They are moved into the
//      conference first, with conference.ts redirectChild (the redirect, and recovery, Hold
//      uses); the old app leg's Dial action (after-dial stage=out) brings that leg in too until
//      step 3, and hangs it up after. (Inbound needs no step 0: there the old leg is the child,
//      and if it ends, after-dial step 0 takes the customer into the conference the claim set.)
//   1. wait (250 ms polls, 8 s at most) until the new leg is connected in the conference;
//   2. on a plain inbound call, check the new leg is still there, then redirect the child (the
//      OLD leg); the customer follows through after-dial step 0. Then (inbound or outbound)
//      wait until the customer is connected;
//   3. check once more that the new leg is still on the call (the person may have ended it
//      while the customer was on the way in: nothing else stops the switch), then
//      client_call_sid → the new leg and handoff_state → null, guarded on client_call_sid still
//      being the old leg. BEFORE the old leg ends, so its end is never read as "the holder hung
//      up" (/voice/status holderLegEnded) and the customer never hears the voicemail greeting;
//   4. end the old leg, and record device_switch {phase:'done', from_sid, sid, ms}. `sid` is
//      the new leg on purpose: usage billing collects a call's legs from data.sid. Then look
//      once more for a customer left on their own (a leave let pass while connecting).
// Any failure hangs the new leg up, puts the conference claim back when nothing moved (and the
// plain Dial really is still there), clears handoff_state and records phase 'failed': the old
// device keeps the call. A plain call that had already moved has its conference started for the
// old leg if nothing started it (the new leg left before anyone joined it), so the two talk
// again instead of music and silence. While a move is connecting, the old leg leaving does not
// finish the customer (conference.ts finishIfAlone); if the move then fails, completeHandoff
// runs that check itself. And neither leg of a move leaving ever counts as a transferrer
// leaving mid-consult: a held customer stays held.
//
// ── WHILE IT RINGS ──────────────────────────────────────────────────────────────────────
//   * Hold, Resume and both transfers are refused (handoff_in_progress, refuseWhileSwitching),
//     and so is a second move. A move older than 45 s is over whatever the row says.
//   * The phone not answering, declining or failing: /voice/status?leg=handoff clears the row
//     and records phase 'missed'. A computer that does not answer: the holder's app gives up and
//     cancels; a ring left behind expires at 45 s (GET /calls/:id/handoff then says 'missed').
//   * The call ending (either side hangs up): /voice/status cancels the ring (endRingWithCall).
//   * Cancel (either device, with the key): cleared, the phone's ring canceled, phase 'canceled'
//     (data.reason 'declined' when it came from the device being rung).
//
// ── WHAT THE APPS READ ──────────────────────────────────────────────────────────────────
// The row carries the state (ringing / connecting / null) and every change broadcasts. A
// finished move's outcome is a phone_call_events row of type device_switch, phase offered |
// done | missed | failed | canceled; GET /calls/:id/handoff reads both. The key is a capability:
// it goes to the person's own devices (the ring's parameters, GET /handoff/pending) and to
// Twilio inside our own answer URL, never into an event.

import type { Ctx, Env } from "./env";
import {
  conferenceTwiml, finishIfAlone, HANDOFF_WINDOW_MS, hasStarted, heldIn, isTerminal, legsOf, redirectChild, switchUnderWay,
  type FinishOutcome,
} from "./conference";
import { addCallEvent, adminClient, callById, must, patchCall, type Admin, type CallRow } from "./db";
import { ApiError, CALL_SID_RE, UUID_RE } from "./http";
import { logFault } from "./log";
import type { TwilioParams } from "./twilioSignature";
import { fetchCall, findConference, listParticipants, updateCall, type TwilioError } from "./twilioRest";
import { hangup, response, say } from "./twiml";

export { HANDOFF_WINDOW_MS, switchUnderWay };

export type HandoffTo = "chrome" | "mobile";
/** GET /calls/:id/handoff. `none`: no move under way and none recorded. */
export type MoveState = "ringing" | "connecting" | "done" | "missed" | "failed" | "canceled" | "none";

/** The phone_call_events type every step of a move is recorded under (data.phase says which). */
export const DEVICE_SWITCH = "device_switch";
/** How long the phone rings. Under HANDOFF_WINDOW_MS, so Twilio's no-answer always lands first. */
export const MOBILE_RING_SECONDS = 25;
/** completeHandoff's waits. Mutable for the tests only. */
export const HANDOFF_POLL = { everyMs: 250, limitMs: 8_000 };

export const SAY_GONE = "That call has already moved or ended.";

export function isHandoffTo(v: unknown): v is HandoffTo {
  return v === "chrome" || v === "mobile";
}

/**
 * Does this person hold the call for us, so they may move it? The one who answered it, or the
 * one who placed an outbound call not yet handed on. Narrower than conference.ts onTheCall: a
 * warm transferrer still consulting in the conference does not hold the call (the teammate
 * does), so they cannot move it.
 */
export function holdsCall(userId: string, call: Pick<CallRow, "answered_by" | "direction" | "placed_by" | "transferred_from">): boolean {
  return call.answered_by === userId || (call.direction === "out" && call.placed_by === userId && !call.transferred_from);
}

/** Hold, Resume and both transfers while a move is under way: refused, the move would land on a call that changed under it. */
export function refuseWhileSwitching(call: Pick<CallRow, "handoff_state" | "handoff_at">): void {
  if (switchUnderWay(call)) {
    throw new ApiError("handoff_in_progress", "The call is moving to your other device. Wait for it to finish.");
  }
}

export function goneTwiml(): string {
  return response(say(SAY_GONE), hangup());
}

/** The customer's side of the call, as the row has it (an inbound caller may be "Anonymous"). */
export function customerOf(call: Pick<CallRow, "direction" | "from_e164" | "to_e164">): string {
  return String((call.direction === "in" ? call.from_e164 : call.to_e164) ?? "").slice(0, 40);
}

/**
 * The custom parameters the phone's ring carries (phone-core readHandoffParams): enough to show
 * the call it is taking over (who, which way, since when, on hold or not) without a lookup, and
 * the call id and key to answer it with. URL-encoded onto the client address by the caller.
 */
export function handoffParams(call: CallRow, key: string, held: boolean): Record<string, string> {
  const customer = customerOf(call);
  return {
    handoff: "1",
    call_id: call.id,
    key,
    ...(customer ? { customer } : {}),
    ...(call.contact_id ? { contact_id: call.contact_id } : {}),
    direction: call.direction,
    ...(call.answered_at ? { answered_at: call.answered_at } : {}),
    held: held ? "1" : "0",
  };
}

/**
 * Is the customer on hold right now, as the device taking over should show it? Only a call in
 * its conference can be: held as a participant, or waiting in a conference nothing proves has
 * started (a plain Hold; conference.ts HAS IT STARTED?), or no conference yet (the legs are still
 * moving in after Hold: they arrive waiting). A failed read on a call in its conference says
 * yes. The new leg of such a call joins waiting (start=false), so if the customer really is
 * waiting, a screen showing a live call would leave the person in silence with no Resume to
 * press; one showing Resume for a customer who is in fact talking costs nothing, because
 * Resume redirects nobody into a started conference and takes off only a hold that is there.
 */
export async function customerHeldNow(env: Env, admin: Admin, call: CallRow): Promise<boolean> {
  if (call.transfer_state !== "conference" || !call.twilio_call_sid) return false;
  try {
    const conf = await findConference(env, call.id);
    if (!conf) return true;
    const parts = await listParticipants(env, conf.sid);
    if (heldIn(parts, call.twilio_call_sid)) return true;
    return !(await hasStarted(admin, call.id, conf.sid, parts));
  } catch {
    return true;
  }
}

// ── The answer: /voice/handoff (the phone) and /voice/outbound's branch (the computer) ────

/**
 * The other device answered move `key` with leg `newLeg`. Claims it (ringing → connecting, and on
 * a plain call the conference too) and answers the leg with the call's conference, or refuses
 * with SAY_GONE. The move itself finishes in waitUntil (completeHandoff).
 */
export async function handoffAnswer(env: Env, ec: Ctx, call: CallRow, key: string, newLeg: string, to: HandoffTo): Promise<string> {
  if (!UUID_RE.test(key) || !CALL_SID_RE.test(newLeg)) return goneTwiml();
  const oldLeg = call.handoff_from_sid ?? "";
  if (call.handoff_state !== "ringing" || call.handoff_to !== to || call.handoff_key !== key || !oldLeg
    || call.status !== "in_progress" || call.ended_at || call.transfer_state === "transferring") {
    return goneTwiml();
  }
  const plain = !call.transfer_state;
  const now = Date.now();
  const won = await patchCall(adminClient(env), call.id, {
    handoff_state: "connecting",
    handoff_sid: newLeg,
    // From here the 45 s count from the answer: the switch itself takes seconds.
    handoff_at: new Date(now).toISOString(),
    ...(plain ? { transfer_state: "conference" } : {}),
  }, (q) => {
    const g = q.eq("handoff_state", "ringing").eq("handoff_key", key).eq("handoff_to", to)
      .gt("handoff_at", new Date(now - HANDOFF_WINDOW_MS).toISOString())
      .eq("status", "in_progress").is("ended_at", null).eq("client_call_sid", oldLeg)
      // The phone's ring is the only leg that may answer it (its SID is stored once Twilio
      // returns it; an answer can beat that write by milliseconds).
      .or(`handoff_sid.is.null,handoff_sid.eq.${newLeg}`);
    return plain ? g.is("transfer_state", null) : g.eq("transfer_state", "conference");
  });
  if (!won) return goneTwiml();
  ec.waitUntil(completeHandoff(env, {
    callId: call.id, clientId: call.client_id, key, to, newLeg, oldLeg, plain, t0: now,
  }).catch((e) => logFault({
    code: "handoff_complete_failed", clientId: call.client_id, message: (e as Error)?.message ?? String(e), context: { callId: call.id },
  })));
  return conferenceTwiml(env, call.id, "agent", plain);
}

/** /voice/handoff: the answer URL of the ring placed to the person's phone. */
export async function voiceHandoff(env: Env, ec: Ctx, p: TwilioParams, url: URL): Promise<string> {
  const callId = url.searchParams.get("call") ?? "";
  const key = url.searchParams.get("k") ?? "";
  const leg = String(p.CallSid ?? "");
  if (!UUID_RE.test(callId) || !UUID_RE.test(key) || !CALL_SID_RE.test(leg)) return goneTwiml();
  const call = await callById(adminClient(env), callId);
  return call ? handoffAnswer(env, ec, call, key, leg, "mobile") : goneTwiml();
}

// ── Make before break ───────────────────────────────────────────────────────────────────

export interface Switch {
  callId: string;
  clientId: string;
  key: string;
  to: HandoffTo;
  newLeg: string;
  oldLeg: string;
  /** The call was a plain Dial: completeHandoff moves the customer into the conference. */
  plain: boolean;
  t0: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll the call's conference until leg `sid` is connected in it, or HANDOFF_POLL.limitMs. */
async function connectedInConference(env: Env, callId: string, sid: string): Promise<boolean> {
  const until = Date.now() + HANDOFF_POLL.limitMs;
  for (;;) {
    try {
      const conf = await findConference(env, callId);
      if (conf && (await listParticipants(env, conf.sid)).some((x) => x.call_sid === sid && x.status === "connected")) return true;
    } catch {
      // A failed read is one more round, not a failed move.
    }
    if (Date.now() + HANDOFF_POLL.everyMs > until) return false;
    await sleep(HANDOFF_POLL.everyMs);
  }
}

/**
 * Is leg `sid` still on the call: live by Twilio's own record, and connected in the call's
 * conference? Undefined when Twilio could not be read (the caller decides what that means).
 */
async function stillOnCall(env: Env, callId: string, sid: string): Promise<boolean | undefined> {
  try {
    const leg = await fetchCall(env, sid);
    if (!leg || isTerminal(leg.status)) return false;
    const conf = await findConference(env, callId);
    const me = conf ? (await listParticipants(env, conf.sid)).find((x) => x.call_sid === sid) : undefined;
    return me?.status === "connected";
  } catch {
    return undefined;
  }
}

/** Steps 0 to 4 of THE ANSWER, THEN MAKE BEFORE BREAK. Runs in waitUntil after handoffAnswer. */
export async function completeHandoff(env: Env, s: Switch): Promise<"done" | "failed"> {
  const admin = adminClient(env);
  let moved = false;
  const fail = (reason: string, err?: unknown, callOver = false) => failSwitch(env, admin, s, reason, moved, err, callOver);
  // The new leg can end at any point (the person pressing End on it while the other side is on
  // its way in). Its leave changes nothing while the switch is connecting (the old leg still
  // keeps the customer company), and its status callback is ignored until it holds the call, so
  // only these checks stop the switch from handing the call to a leg that is gone. A failed
  // read is not a failed switch: step 1 saw the leg, and step 4's last look catches the rest.
  const newLegGone = async () => (await stillOnCall(env, s.callId, s.newLeg)) === false;
  // The customer's leg, once a plain call's child has been redirected (steps 0 and 2).
  let customer: string | null = null;
  /** THE MOVE, step 2 (conference.ts redirectChild). "failed" when the switch is over. */
  const moveChild = async (read?: CallRow | null): Promise<"failed" | null> => {
    const row = read !== undefined ? read : await callById(admin, s.callId);
    if (!row || row.ended_at || !row.twilio_call_sid || row.client_call_sid !== s.oldLeg) return fail("call_changed");
    const { outcome, error } = await redirectChild(env, row);
    if (outcome === "stayed") return fail("move_failed", error);
    moved = true;
    customer = row.twilio_call_sid;
    // "gone": the redirected child had already ended. Inbound that is the old leg, and the
    // customer follows into the conference all the same (after-dial step 0); outbound it is
    // the customer, so the call is over.
    if (outcome === "gone" && legsOf(row).childRole === "customer") return fail("call_over", error, true);
    return null;
  };
  try {
    // 0.
    if (s.plain) {
      const row = await callById(admin, s.callId);
      if (row && legsOf(row).childRole === "customer" && (await moveChild(row))) return "failed";
    }

    // 1.
    if (!(await connectedInConference(env, s.callId, s.newLeg))) return await fail("new_leg_not_connected");

    // 2.
    if (s.plain) {
      if (!moved) {
        if (await newLegGone()) return await fail("new_leg_gone");
        if (await moveChild()) return "failed";
      }
      const sid = customer as string | null;
      if (!sid) return await fail("call_changed");
      if (!(await connectedInConference(env, s.callId, sid))) {
        // Not listed in time. A customer whose leg is still live is on the way into the
        // conference the new leg is already in, so the switch goes on; one that has ended is a
        // call that is over.
        const leg = await fetchCall(env, sid).catch(() => undefined);
        if (leg === undefined) return await fail("customer_not_connected");
        if (!leg || isTerminal(leg.status)) return await fail("call_over", undefined, true);
        await logFault({
          code: "handoff_customer_slow", severity: "warn", clientId: s.clientId, context: { callId: s.callId },
          message: "Moving a call to another device: the customer's leg was not listed in the conference in time but is live; the move went on.",
        });
      }
    }

    // 3. Before the old leg ends (see the header), and only to a leg that is still there.
    if (await newLegGone()) return await fail("new_leg_gone");
    const swapped = await patchCall(admin, s.callId, { client_call_sid: s.newLeg, handoff_state: null },
      (q) => q.eq("client_call_sid", s.oldLeg).eq("handoff_key", s.key).eq("handoff_state", "connecting"));
    if (!swapped) return await fail("lost_race");

    // 4. The event first: the old device, disconnected next, asks GET /calls/:id/handoff how
    // its call ended (moveStateOf also reads the swapped row as done). The old leg is usually
    // live still (and on an outbound plain call, possibly hung up by after-dial already).
    await addCallEvent(admin, s.callId, DEVICE_SWITCH, {
      phase: "done", to: s.to, from_sid: s.oldLeg, sid: s.newLeg, ms: Date.now() - s.t0,
    });
    await updateCall(env, s.oldLeg, { Status: "completed" }).catch(() => {});
    // A leave let pass while this was connecting (the old leg's, or the new leg's in the moment
    // between step 3's check and the swap) is looked at once more, now that neither excuse
    // holds: a customer the person's legs have both left is finished, never left on music.
    await finishIfLeftAlone(env, admin, s.callId, s.oldLeg).catch((e) => logFault({
      code: "handoff_recheck_failed", clientId: s.clientId, message: (e as Error)?.message ?? String(e), context: { callId: s.callId },
    }));
    return "done";
  } catch (e) {
    return fail("error", e);
  }
}

/**
 * The call's customer, if alone in its conference now that leg `gone` has left, is finished as
 * conference.ts finishIfAlone finishes any (voicemail if they were waiting, else hung up).
 */
async function finishIfLeftAlone(env: Env, admin: Admin, callId: string, gone: string): Promise<FinishOutcome | null> {
  const row = await callById(admin, callId);
  if (!row || row.transfer_state !== "conference" || row.ended_at) return null;
  const conf = await findConference(env, callId);
  return conf ? finishIfAlone(env, admin, row, conf.sid, "auto", gone) : null;
}

/**
 * Has a plain call left its Dial although the switch never moved it? The claim set
 * transfer_state = 'conference', so if the Dial ended meanwhile, after-dial step 0 has taken the
 * customer (the Dial's parent, on an inbound call) into the conference: the old leg (the child)
 * ending is exactly that. Or the customer is listed in the conference already. A read that fails
 * says no: the claim goes back, as it always did.
 */
async function plainCallLeftDial(env: Env, s: Switch, row: CallRow | null): Promise<boolean> {
  const customer = row?.twilio_call_sid;
  if (!row || !customer) return false;
  if (legsOf(row).childRole === "agent") {
    const old = await fetchCall(env, s.oldLeg).catch(() => undefined);
    if (old === null || (old && isTerminal(old.status))) return true;
  }
  try {
    const conf = await findConference(env, s.callId);
    if (!conf) return false;
    return (await listParticipants(env, conf.sid)).some((p) => p.call_sid === customer && p.status !== "complete" && p.status !== "failed");
  } catch {
    return false;
  }
}

/**
 * A plain call that moved into its conference for a switch that then failed: the customer was
 * TALKING, so they must not be left waiting with the old leg in a conference nothing started
 * (the new leg, the one that would have started it, left before they joined), the customer on
 * hold music and the old device in silence. It is started for the old leg as Resume does
 * (start=true); into a conference that had started, that is a moment's leave and re-join.
 */
async function restartForOldLeg(env: Env, admin: Admin, s: Switch): Promise<void> {
  const conf = await findConference(env, s.callId);
  if (!conf) return;
  const parts = await listParticipants(env, conf.sid).catch(() => null);
  if (await hasStarted(admin, s.callId, conf.sid, parts)) return;
  const old = await fetchCall(env, s.oldLeg).catch(() => undefined);
  if (!old || isTerminal(old.status)) return;
  await updateCall(env, s.oldLeg, { Twiml: conferenceTwiml(env, s.callId, "agent", true) });
}

/**
 * The old device keeps the call: see the header. `callOver`: the customer has gone, so the old
 * leg is ended too rather than left waiting in a conference nobody else will join (Hold's "gone"
 * does the same). Never throws.
 */
async function failSwitch(env: Env, admin: Admin, s: Switch, reason: string, moved: boolean, err?: unknown, callOver = false): Promise<"failed"> {
  try {
    await updateCall(env, s.newLeg, { Status: "completed" }).catch(() => {});
    if (callOver) await updateCall(env, s.oldLeg, { Status: "completed" }).catch(() => {});
    // Nothing moved on a plain call: the claim goes back, as Hold's "stayed" does
    // (routes/conference.ts moveIntoConference), unless the call left its Dial anyway (the old
    // leg ended while this was connecting): then it is in its conference whatever we did, and
    // putting the claim back would leave the customer there with nothing watching them.
    let leftDial = false;
    if (s.plain && !moved) {
      if (!callOver) leftDial = await plainCallLeftDial(env, s, await callById(admin, s.callId));
      if (!leftDial) await patchCall(admin, s.callId, { transfer_state: null }, (q) => q.eq("transfer_state", "conference"));
    }
    // The outcome before the row clears, so an app that re-reads on the row's broadcast finds it.
    await addCallEvent(admin, s.callId, DEVICE_SWITCH, {
      phase: "failed", to: s.to, reason, sid: s.newLeg, from_sid: s.oldLeg, ms: Date.now() - s.t0,
    });
    await patchCall(admin, s.callId, { handoff_state: null }, (q) => q.eq("handoff_key", s.key).eq("handoff_state", "connecting"));
    const te = err as TwilioError | undefined;
    await logFault({
      code: "handoff_failed", severity: "warn", clientId: s.clientId,
      message: `Moving a call to another device failed (${reason}); the call stayed where it was.`,
      context: { callId: s.callId, reason, to: s.to, twilioStatus: te?.status ?? null, twilioCode: te?.code ?? null },
    });
    // The old leg may have hung up while the move was connecting (finishIfAlone let that pass):
    // a customer now alone in the conference is finished as any other would be. One that left
    // its Dial with the old leg may still be on the way in through after-dial: given a moment.
    if (!callOver && (moved || !s.plain || leftDial)) {
      if (leftDial) {
        const row = await callById(admin, s.callId);
        if (row?.twilio_call_sid) await connectedInConference(env, s.callId, row.twilio_call_sid);
      }
      const outcome = await finishIfLeftAlone(env, admin, s.callId, s.newLeg);
      if (outcome === "not_alone" && s.plain && moved) await restartForOldLeg(env, admin, s);
    }
  } catch (e) {
    await logFault({ code: "handoff_rollback_failed", clientId: s.clientId, message: (e as Error)?.message ?? String(e), context: { callId: s.callId, reason } });
  }
  return "failed";
}

// ── While it rings ──────────────────────────────────────────────────────────────────────

/**
 * Clear a ringing move (this attempt's key only), stop the phone's ring if there is one, and
 * record it as phase 'canceled' with why (`data`: reason canceled | declined | call_ended,
 * user). False when there was nothing ringing under that key (it was answered, missed or
 * canceled already).
 */
export async function cancelRing(env: Env, admin: Admin, call: Pick<CallRow, "id" | "handoff_to">, key: string, data: Record<string, unknown>): Promise<boolean> {
  const cleared = must(
    await admin.from("phone_calls").update({ handoff_state: null })
      .eq("id", call.id).eq("handoff_key", key).eq("handoff_state", "ringing").select("id, handoff_sid, handoff_to"),
    "cancel handoff",
  ) as { id: string; handoff_sid: string | null; handoff_to: HandoffTo | null }[] | null;
  if (!cleared?.length) return false;
  const ring = cleared[0].handoff_sid ?? null;
  // The outcome right after the clear, before the Twilio round trip: the clear has already
  // broadcast, and the device that asked re-reads GET /calls/:id/handoff on it. Until this
  // event exists that read says 'none'.
  await addCallEvent(admin, call.id, DEVICE_SWITCH, { phase: "canceled", to: cleared[0].handoff_to ?? call.handoff_to ?? null, sid: ring, ...data });
  // Twilio's `canceled` stops a call that is still queued or ringing. If the phone answered in
  // the same instant, the answer finds the claim gone and hangs up (handoffAnswer).
  if (ring) await updateCall(env, ring, { Status: "canceled" }).catch(() => {});
  return true;
}

/**
 * /voice/status: a leg of the call itself (the one holding it, or the customer's) has ended
 * while a move is ringing. The call is over, so the ring is too: nobody should answer a call
 * that is gone. `signed` false (?key= alone): only when Twilio agrees the leg has ended.
 */
export async function endRingWithCall(env: Env, row: CallRow, sid: string, status: string, signed: boolean): Promise<boolean> {
  if (!isTerminal(status) || row.handoff_state !== "ringing" || !row.handoff_key || !sid) return false;
  if (sid !== row.client_call_sid && sid !== row.twilio_call_sid) return false;
  if (!signed) {
    const leg = await fetchCall(env, sid).catch(() => undefined);
    if (leg === undefined || (leg && !isTerminal(leg.status))) return false;
  }
  return cancelRing(env, adminClient(env), row, row.handoff_key, { reason: "call_ended" });
}

/**
 * /voice/status?leg=handoff: the ring placed to the person's phone. Ending unanswered
 * (no-answer, busy = declined, failed, canceled) while the move is still ringing clears it and
 * records phase 'missed', which tells the device that asked (the row write broadcasts). Its
 * answer is /voice/handoff, and once it holds the call its end is /voice/status's
 * holderLegEnded like any holder's. `signed` false: only when Twilio agrees the leg has ended.
 */
export async function handoffLegStatus(env: Env, row: CallRow, p: TwilioParams, signed: boolean): Promise<void> {
  const status = String(p.CallStatus ?? "");
  const sid = String(p.CallSid ?? "");
  if (!isTerminal(status) || status === "completed" || !CALL_SID_RE.test(sid)) return;
  if (row.handoff_state !== "ringing" || row.handoff_to !== "mobile" || !row.handoff_key) return;
  if (row.handoff_sid && row.handoff_sid !== sid) return;
  if (!signed) {
    const leg = await fetchCall(env, sid).catch(() => null);
    if (!leg || !isTerminal(leg.status)) {
      await logFault({
        code: "handoff_miss_unverified", severity: "warn", clientId: row.client_id, context: { callId: row.id },
        message: "An unsigned missed device-switch ring did not match Twilio's records; the move was left ringing.",
      });
      return;
    }
  }
  const admin = adminClient(env);
  const cleared = await patchCall(admin, row.id, { handoff_state: null }, (q) => q.eq("handoff_state", "ringing")
    .eq("handoff_key", row.handoff_key).or(`handoff_sid.is.null,handoff_sid.eq.${sid}`));
  if (cleared) await addCallEvent(admin, row.id, DEVICE_SWITCH, { phase: "missed", to: "mobile", sid, status });
}

// ── What the apps read ──────────────────────────────────────────────────────────────────

export interface SwitchEvent {
  at: string;
  data: Record<string, unknown> | null;
}

/** The Worker's own device_switch events on a call, newest first (the apps' marks never count). */
export async function switchEvents(admin: Admin, callId: string): Promise<SwitchEvent[]> {
  const rows = (must(
    await admin.from("phone_call_events").select("call_id, type, at, data").eq("call_id", callId)
      .eq("type", DEVICE_SWITCH).order("at", { ascending: false }).limit(20),
    "read device switch events",
  ) as SwitchEvent[] | null) ?? [];
  return rows.filter((e) => e.data?.source !== "app")
    .sort((a, b) => (Date.parse(b.at) - Date.parse(a.at)) || (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

const PHASE_STATE: Record<string, MoveState> = { done: "done", missed: "missed", failed: "failed", canceled: "canceled" };

/**
 * How the latest move on this call stands: the row while one is under way (a ring past the
 * window reads 'missed', a stuck switch 'failed'), else the latest device_switch event's phase.
 * A row whose holder IS the move's answering leg has been handed over, so it reads 'done' even
 * in the moment before that event is written. Otherwise an outcome written just after the row
 * changed can be missed for that moment ('none'): an app watching a move keeps watching on
 * 'none' until its own limit.
 */
export async function moveStateOf(admin: Admin, call: CallRow, now = Date.now()): Promise<{ state: MoveState; to: HandoffTo | null }> {
  if (call.handoff_state === "ringing" || call.handoff_state === "connecting") {
    const to = call.handoff_to ?? null;
    if (switchUnderWay(call, now)) return { state: call.handoff_state, to };
    return { state: call.handoff_state === "ringing" ? "missed" : "failed", to };
  }
  const last = (await switchEvents(admin, call.id))[0];
  const swapped = !!call.handoff_sid && call.client_call_sid === call.handoff_sid;
  if (!last) return swapped ? { state: "done", to: call.handoff_to ?? null } : { state: "none", to: null };
  const to = isHandoffTo(last.data?.to) ? last.data!.to as HandoffTo : null;
  const state = PHASE_STATE[String(last.data?.phase ?? "")] ?? "none";
  return state === "none" && swapped ? { state: "done", to: call.handoff_to ?? to } : { state, to };
}
