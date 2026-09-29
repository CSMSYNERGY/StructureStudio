// POST /calls/:id/hold, /calls/:id/resume and /calls/:id/warm-transfer (plan 9C, design b).
// How the conference works, and why the CHILD leg is the one redirected, is in ../conference.ts.
//
// `:id` is the phone_calls id or either leg's CallSid, the same as /calls/:id/transfer.
// They answer {ok:true, held, call_id}: held is true after hold, false after resume, and after
// warm-transfer true when it had to move the call (the customer waits on hold music until the
// teammate answers, then all three talk) or null when the hold state did not change: a
// customer on hold stays on hold (made sure of by keepCustomerHeld) while you and the teammate
// talk, and Resume brings them in; a customer you were talking to in the conference (after
// Resume) stays in the call, and the teammate joins the two of you. call_id is the phone_calls
// id: an OUTBOUND app only knows its own leg's CallSid, and once a warm transfer is answered
// that CallSid no longer resolves the call (client_call_sid moves to the teammate's leg), so
// the app should use call_id from here on.
//
// warm-transfer also answers customer_held: true when the customer is held as a participant
// through the consult (a private talk; Resume brings them in), false when they are waiting on
// music or talking and will be connected when the teammate answers, null if a failed read left
// it unknown. A refusal that knows where the customer is says so beside `error` ({held,
// call_id}, http.ts ApiError extra): true after a move whose teammate couldn't be rung (press
// Resume); after a failed ring from a conference, what keepCustomerHeld found or made; false
// when a Hold pressed while a Resume was still landing did not hold anyone.

import type { Ctx, Env } from "../env";
import { resumeInFlight } from "../callEvents";
import { requireCaller, type Caller } from "../context";
import { addCallEvent, callerContext, must, routeForNumber, type CallRow } from "../db";
import {
  CONFERENCE_EVENTS, HOLD_MUSIC, conferenceTwiml, isTerminal, legsOf, nextTransferState, onTheCall,
  refuseEmergencyCallback, transferParams, type CallAction,
} from "../conference";
import { ApiError, ok, readJson, UUID_RE } from "../http";
import { toIdentity } from "../identity";
import { logFault } from "../log";
import {
  addParticipant, fetchCall, findConference, listParticipants, TwilioError, updateCall, updateParticipant,
} from "../twilioRest";
import { hook } from "../urls";
import { resolveCall } from "./calls";
import { onDnd } from "./voice";

/** The call, checked the same way for all three: yours, live, not an emergency call. */
async function liveCallOf(c: Caller, idParam: string): Promise<CallRow> {
  const call = await resolveCall(c, idParam);
  if (!call) throw new ApiError("not_found", "That call wasn't found.");
  if (!onTheCall(c.userId, call)) throw new ApiError("not_found", "Only the person on the call can do that.");
  if (call.status !== "in_progress" || call.ended_at) throw new ApiError("bad_request", "That call has already ended.");
  if (call.is_emergency) throw new ApiError("bad_request", "An emergency call can't be put on hold or transferred.");
  return call;
}

function twilioFailure(ec: Ctx, c: Caller, call: CallRow, what: string, e: unknown): void {
  const te = e as TwilioError;
  ec.waitUntil(logFault({
    code: `${what}_failed`, clientId: c.ctx.client_id,
    message: `${what}: Twilio refused (HTTP ${te?.status ?? 0}, code ${te?.code ?? 0}).`,
    context: { callId: call.id },
  }));
}

/** How long a redirect whose answer was lost gets to show up in the conference. */
const MOVE_SETTLE_MS = 700;

/**
 * What a failed redirect of the child leg really left behind. Twilio's own error means it did
 * nothing; a request that got NO answer (status 0) may still have been carried out.
 *   gone    the child had already ended: our side hung up, or dropped, as the button was pressed
 *   moved   the child is in the conference: Twilio did it, only its answer was lost
 *   stayed  the plain call is as it was
 */
async function whatTheMoveDid(env: Env, callId: string, child: string, err: unknown): Promise<"gone" | "moved" | "stayed"> {
  const leg = await fetchCall(env, child);
  if (!leg || isTerminal(leg.status)) return "gone";
  if (!(err instanceof TwilioError) || err.status !== 0) return "stayed";
  for (let i = 0; i < 2; i++) {
    if (i) await new Promise((r) => setTimeout(r, MOVE_SETTLE_MS));
    const conf = await findConference(env, callId);
    const parts = conf ? await listParticipants(env, conf.sid) : [];
    if (parts.some((p) => p.call_sid === child && p.status !== "complete" && p.status !== "failed")) return "moved";
  }
  return "stayed";
}

/**
 * Move a plain Dial into the call's conference: claim, then redirect the child leg. The
 * parent follows by itself through the Dial's action (after-dial step 0), which answers it
 * with the conference as soon as it sees the claim.
 *
 * When the redirect fails, what it left behind decides (whatTheMoveDid):
 *   moved   keep the claim: the move happened and after-dial is taking the parent in.
 *   stayed  put the claim back: the call is exactly as it was.
 *   gone    put the claim back and end the PARENT leg too. after-dial may already have
 *           answered it with a conference nobody else will ever join; ending it is what a
 *           plain call does when one side hangs up (after-dial step 2). Only if the claim was
 *           still ours: a cold transfer that took the call meanwhile is left alone.
 */
async function moveIntoConference(env: Env, ec: Ctx, c: Caller, call: CallRow, action: CallAction): Promise<void> {
  const legs = legsOf(call);
  if (!legs.child || !legs.customer) throw new ApiError("bad_request", "This call can't be moved yet. Try again in a moment.");
  const claimed = must(await c.admin.from("phone_calls").update({ transfer_state: "conference" })
    .eq("id", call.id).is("transfer_state", null).select("id"), "claim conference") as { id: string }[] | null;
  if (!claimed?.length) throw new ApiError("bad_request", "Something else is happening on this call. Try again in a moment.");
  try {
    await updateCall(env, legs.child, { Twiml: conferenceTwiml(env, call.id, legs.childRole) });
    return;
  } catch (e) {
    const what = action === "hold" ? "hold" : "warm_transfer";
    const outcome = await whatTheMoveDid(env, call.id, legs.child, e).catch(() => "stayed" as const);
    if (outcome === "moved") {
      ec.waitUntil(logFault({
        code: `${what}_answer_lost`, severity: "warn", clientId: c.ctx.client_id, context: { callId: call.id },
        message: `${what}: Twilio's answer to the redirect was lost, but the leg is in the conference.`,
      }));
      return;
    }
    const { data: back } = await c.admin.from("phone_calls").update({ transfer_state: null })
      .eq("id", call.id).eq("transfer_state", "conference").select("id");
    if (outcome === "gone") {
      const parent = legs.childRole === "agent" ? legs.customer : legs.agent;
      if (parent && Array.isArray(back) && back.length) {
        ec.waitUntil(updateCall(env, parent, { Status: "completed" }).catch(() => {}));
      }
      throw new ApiError("bad_request", "That call has already ended.");
    }
    twilioFailure(ec, c, call, what, e);
    throw new ApiError("twilio_error", action === "hold"
      ? "Hold didn't work. You're still on the call."
      : "The transfer didn't go through. You're still on the call.");
  }
}

/**
 * Warm transfer on a call already in its conference. The teammate joins with
 * startConferenceOnEnter=true, and starting a conference connects everyone WAITING in it. A
 * conference that has not started (plain Hold) has the customer waiting, not held, so they
 * would be connected into your private talk with the teammate: hold them through the
 * Participants API first. A started conference needs nothing: a held customer stays held, and
 * a customer you are talking to (after Resume) stays in the call, which the teammate joins.
 * Not there yet (the legs are still moving in after Hold): asks for a moment, rings nobody.
 *
 * Answers `customer_held`: true when the customer is held as a participant through the
 * consult (a private talk with the teammate; Resume brings them in), false when they are
 * talking with you and the teammate joins, null when a failed read left it unknown.
 */
async function keepCustomerHeld(env: Env, ec: Ctx, c: Caller, call: CallRow): Promise<boolean | null> {
  const stillMoving = new ApiError("bad_request", "The call is still being put on hold. Try again in a moment.");
  const failed = (e: unknown) => {
    twilioFailure(ec, c, call, "warm_transfer", e);
    return new ApiError("twilio_error", "Your teammate couldn't be rung. You're still on the call.");
  };
  let conf;
  try {
    conf = await findConference(env, call.id);
  } catch (e) {
    throw failed(e);
  }
  const customer = call.twilio_call_sid;
  if (!conf || !customer) throw stillMoving;
  if (conf.status !== "init") {
    // Started: nothing changes. Held means a Hold after Resume (Participants hold); otherwise
    // the customer is talking with you, or joins the talk if their leg is still on its way in.
    try {
      return (await listParticipants(env, conf.sid))
        .some((p) => p.call_sid === customer && p.hold === true && p.status !== "complete" && p.status !== "failed");
    } catch {
      return null;
    }
  }
  try {
    await updateParticipant(env, conf.sid, customer, { Hold: "true", HoldUrl: HOLD_MUSIC, HoldMethod: "GET" });
  } catch (e) {
    // 404: the customer's leg is not in the conference yet (it follows yours via after-dial).
    if (e instanceof TwilioError && e.status === 404) throw stillMoving;
    throw failed(e);
  }
  return true;
}

// ── POST /calls/:id/hold ────────────────────────────────────────────────────────────

export async function hold(env: Env, ec: Ctx, req: Request, idParam: string): Promise<Response> {
  const c = await requireCaller(env, req);
  const call = await liveCallOf(c, idParam);
  const step = nextTransferState(call.transfer_state, "hold");
  if (!step.ok) throw new ApiError("bad_request", step.message);
  await refuseEmergencyCallback(c.admin, call);

  let afterResume = false;
  if (step.move) {
    // A conference that has not started is hold: the customer hears music, you hear silence.
    await moveIntoConference(env, ec, c, call, "hold");
  } else {
    const customer = call.twilio_call_sid;
    const holdCustomer = (sid: string, customerSid: string) =>
      updateParticipant(env, sid, customerSid, { Hold: "true", HoldUrl: HOLD_MUSIC, HoldMethod: "GET" });
    let conf;
    try {
      conf = await findConference(env, call.id);
      // Not found: the legs are still on their way in, and they arrive held.
      if (conf && conf.status !== "init" && customer) await holdCustomer(conf.sid, customer);
    } catch (e) {
      twilioFailure(ec, c, call, "hold", e);
      throw new ApiError("twilio_error", "Hold didn't work. You're still on the call.");
    }
    // "init": nobody has started it, which already is hold... unless Resume was pressed just
    // before this and its leg has not landed yet. When it does it starts the conference and
    // connects a customer who is only waiting, so "held" would be untrue. Hold the customer
    // through the Participants API now (as keepCustomerHeld does), so they stay on hold when
    // it starts; and when that can't be done, say the customer is NOT held.
    afterResume = !!conf && conf.status === "init" && !!customer
      && await resumeInFlight(c.admin, call.id).catch(() => false);
    if (afterResume && conf && customer) {
      try {
        await holdCustomer(conf.sid, customer);
      } catch (e) {
        const truth = { held: false, call_id: call.id };
        // 404: the customer's leg is not in yet either; it will join the started conference.
        if (e instanceof TwilioError && e.status === 404) {
          throw new ApiError("bad_request", "The call is still coming off hold. Press Hold again in a moment.", undefined, truth);
        }
        twilioFailure(ec, c, call, "hold", e);
        throw new ApiError("twilio_error", "Hold didn't work. You're still on the call.", undefined, truth);
      }
    }
  }
  ec.waitUntil(addCallEvent(c.admin, call.id, "hold", { user: c.userId, moved: step.move, ...(afterResume ? { after_resume: true } : {}) }));
  return ok({ held: true, call_id: call.id });
}

// ── POST /calls/:id/resume ──────────────────────────────────────────────────────────

export async function resume(env: Env, ec: Ctx, req: Request, idParam: string): Promise<Response> {
  const c = await requireCaller(env, req);
  const call = await liveCallOf(c, idParam);
  const step = nextTransferState(call.transfer_state, "resume");
  if (!step.ok) throw new ApiError("bad_request", step.message);

  let conf;
  try {
    conf = await findConference(env, call.id);
  } catch (e) {
    twilioFailure(ec, c, call, "resume", e);
    throw new ApiError("twilio_error", "Couldn't take the call off hold. Please try again.");
  }
  if (!conf) throw new ApiError("bad_request", "The call is still being put on hold. Try again in a moment.");
  const starting = conf.status === "init";
  try {
    if (starting) {
      // Nobody has started it: bring the agent's leg back in as the one who starts it. A warm
      // transfer from hold put the customer on a Participants hold (keepCustomerHeld); starting
      // the conference would not end that, so it comes off first.
      if (!call.client_call_sid) throw new ApiError("bad_request", "The call is still being put on hold. Try again in a moment.");
      const customer = call.twilio_call_sid;
      if (customer && (await listParticipants(env, conf.sid)).some((p) => p.call_sid === customer && p.hold === true)) {
        await updateParticipant(env, conf.sid, customer, { Hold: "false" });
      }
      await updateCall(env, call.client_call_sid, { Twiml: conferenceTwiml(env, call.id, "agent", true) });
    } else if (call.twilio_call_sid) {
      await updateParticipant(env, conf.sid, call.twilio_call_sid, { Hold: "false" });
    }
  } catch (e) {
    if (e instanceof ApiError) throw e;
    twilioFailure(ec, c, call, "resume", e);
    throw new ApiError("twilio_error", "Couldn't take the call off hold. Please try again.");
  }
  const event = addCallEvent(c.admin, call.id, "resume", { user: c.userId });
  // Your leg is still on its way back in, so the conference reads 'init' for a moment: a Hold
  // pressed now must see this event (hold, resumeInFlight), so it is written before the answer.
  // A lost mark never fails the press: Twilio has already done it.
  if (starting) await event.catch(() => {});
  else ec.waitUntil(event);
  return ok({ held: false, call_id: call.id });
}

// ── POST /calls/:id/warm-transfer ───────────────────────────────────────────────────

/**
 * Ring a teammate INTO the call. From a plain call, the customer waits on hold music while
 * they ring (a call just moved into its conference has not started); when the teammate
 * answers, the conference starts and all three of you talk, and you hang up when you are
 * ready. If the customer was already on hold, they stay on hold (keepCustomerHeld): you and the
 * teammate talk first, and Resume brings the customer in; hanging up instead hands the
 * customer to the teammate, off hold (conference.ts HANDED OVER ON HOLD). If you were talking
 * to the customer in the conference (after Resume), the teammate joins the two of you. A
 * teammate who does not answer leaves things as they were, except that a customer left on
 * their own goes to voicemail (conference.ts warmLegStatus).
 */
export async function warmTransfer(env: Env, ec: Ctx, req: Request, idParam: string): Promise<Response> {
  const c = await requireCaller(env, req);
  const body = await readJson(req);
  const target = String(body.to_user_id ?? "");
  if (!UUID_RE.test(target)) throw new ApiError("bad_request", "Pick a teammate to transfer to.");
  if (target === c.userId) throw new ApiError("bad_request", "You can't transfer a call to yourself.");
  const call = await liveCallOf(c, idParam);
  const step = nextTransferState(call.transfer_state, "warm");
  if (!step.ok) throw new ApiError("bad_request", step.message);

  const [tctx, tset, info] = await Promise.all([
    callerContext(c.admin, target),
    c.admin.from("phone_user_settings").select("dnd, dnd_until").eq("user_id", target).maybeSingle(),
    call.direction === "in" ? routeForNumber(c.admin, call.to_e164) : Promise.resolve(null),
  ]);
  await refuseEmergencyCallback(c.admin, call, info);
  if (!tctx || tctx.client_id !== c.ctx.client_id || tctx.phone_level === "none") {
    throw new ApiError("not_found", "That teammate can't take calls.");
  }
  const tdnd = (tset.data ?? null) as { dnd?: boolean; dnd_until?: string | null } | null;
  // Unlike a cold transfer (where DND means voicemail), you are still on the line here, so
  // the honest answer is to say so and let you choose.
  if (tdnd && onDnd({ dnd: tdnd.dnd === true, dnd_until: tdnd.dnd_until ?? null })) {
    throw new ApiError("bad_request", "That teammate is on Do Not Disturb.");
  }

  // A plain call just moved waits on music (not held as a participant) and is connected when
  // the teammate answers; otherwise keepCustomerHeld says.
  let customerHeld: boolean | null = false;
  if (step.move) await moveIntoConference(env, ec, c, call, "warm");
  else customerHeld = await keepCustomerHeld(env, ec, c, call);

  const builderNumber = call.direction === "in" ? call.to_e164 : call.from_e164;
  // Custom parameters ride on the client address (the Participants API has no <Parameter>),
  // so the teammate's app gets what a cold transfer's <Parameter>s carry. The leg rings From
  // the business's own number, so customer_e164 (and contact_id) is how it shows the caller.
  const query = new URLSearchParams(transferParams(call, c.userId)).toString();
  const to = `client:${toIdentity(target, tctx.device_generation)}?${query}`;
  let sid: string;
  try {
    sid = await addParticipant(env, call.id, {
      From: builderNumber,
      To: to,
      StartConferenceOnEnter: "true",
      EndConferenceOnExit: "false",
      Beep: "false",
      Timeout: "20",
      StatusCallback: hook(env, "/voice/status", { call: call.id, leg: "warm", user: target }),
      StatusCallbackMethod: "POST",
      StatusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      ConferenceStatusCallback: hook(env, "/voice/conference", { call: call.id }),
      ConferenceStatusCallbackMethod: "POST",
      ConferenceStatusCallbackEvent: [CONFERENCE_EVENTS],
    });
  } catch (e) {
    twilioFailure(ec, c, call, "warm_transfer", e);
    // The body says where the customer is now (phone-core refusalHeld): after a move they wait
    // on hold music whatever the press did, so the app shows Resume; otherwise the hold state
    // is what keepCustomerHeld found (or made).
    throw new ApiError("twilio_error", step.move
      ? "Your teammate couldn't be rung. The customer is on hold; press Resume to talk to them."
      : "Your teammate couldn't be rung. You're still on the call.",
    undefined, { held: step.move ? true : customerHeld, call_id: call.id });
  }

  const rang = [...new Set([...(call.rang_user_ids ?? []), target])];
  ec.waitUntil((async () => {
    if (rang.length !== (call.rang_user_ids ?? []).length) {
      await c.admin.from("phone_calls").update({ rang_user_ids: rang }).eq("id", call.id);
    }
    await addCallEvent(c.admin, call.id, "warm_transfer", { from: c.userId, to: target, sid: sid || null, moved: step.move });
  })());
  return ok({ held: step.move ? true : null, call_id: call.id, customer_held: customerHeld });
}
