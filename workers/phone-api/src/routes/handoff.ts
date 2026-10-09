// POST /calls/:id/handoff, POST /calls/:id/handoff/cancel, GET /calls/:id/handoff and
// GET /handoff/pending: the apps' side of moving a live call to the person's other device.
// How a move works, end to end, is in ../handoff.ts.
//
// `:id` is the phone_calls id or a leg's CallSid, as for /calls/:id/transfer (an outbound app
// only knows its own leg's CallSid). Every answer carries `call_id`, the phone_calls id. Status
// and cancel also find a call by the leg a move took it FROM (handoff_from_sid): once the move
// is done that leg's CallSid matches neither client_call_sid nor twilio_call_sid, and that is
// exactly when the old device asks how its call ended (myCall).
//
//   POST   /calls/:id/handoff          {to:'chrome'|'mobile', leg_sid} → {state:'ringing', key}
//   POST   /calls/:id/handoff/cancel   {key} → {state}   (either device: the holder giving up,
//                                      or the device being rung saying no; 'canceled' both
//                                      ways, data.reason 'canceled' or 'declined')
//   GET    /calls/:id/handoff          → {state, to}     (ringing | connecting | done | missed |
//                                      failed | canceled | none)
//   GET    /handoff/pending?for=chrome → {offer: null | {...}}  (the computer's ring)
//
// Refusals of the move (code, HTTP): not_your_call 403 (not your call, or not the leg holding
// it), not_live 409, emergency 409 (a 911 call, or an inbound call in the hour after one),
// transfer_in_progress 409 (a cold transfer, or a warm one still ringing), handoff_in_progress
// 409 (a move under 45 s old), no_target_device 409, ring_failed 502 (Twilio would not ring the
// phone; nothing changed).

import type { Ctx, Env } from "../env";
import { warmStates } from "../callEvents";
import { inEmergencyCallbackWindow } from "../conference";
import { requireCaller, type Caller } from "../context";
import { addCallEvent, CALL_COLUMNS, callById, must, type CallRow } from "../db";
import {
  cancelRing, customerHeldNow, customerOf, DEVICE_SWITCH, HANDOFF_WINDOW_MS, handoffParams, holdsCall, isHandoffTo,
  MOBILE_RING_SECONDS, moveStateOf, switchEvents, switchUnderWay, type HandoffTo,
} from "../handoff";
import { ApiError, CALL_SID_RE, ok, readJson, UUID_RE } from "../http";
import { toIdentity } from "../identity";
import { logFault } from "../log";
import { visibleContactIds } from "../scope";
import { createCall, updateCall, type TwilioError } from "../twilioRest";
import { hook } from "../urls";
import { resolveCall } from "./calls";
import { callerTwilioEnv } from "../twilioAccount";

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * The call by id or CallSid, on the caller's tenant, and held by them. `movedFrom`: a CallSid
 * may also be the leg the latest move took the call from. An outbound app that never learned
 * the call id watches its move by its own leg's CallSid, and the swap (handoff.ts step 3) moves
 * client_call_sid off that leg just before ending it, so without this its "how did my call
 * end?" (GET /calls/:id/handoff) would be a 404 and it could not tell a move from a hang-up.
 * Only for reading and canceling: starting a move still needs the leg that holds the call.
 */
async function myCall(c: Caller, idParam: string, movedFrom = false): Promise<CallRow> {
  let call = await resolveCall(c, idParam);
  if (!call && movedFrom && CALL_SID_RE.test(idParam)) {
    const rows = must(
      await c.admin.from("phone_calls").select(CALL_COLUMNS).eq("client_id", c.ctx.client_id)
        .eq("handoff_from_sid", idParam).order("started_at", { ascending: false }).limit(1),
      "resolve moved call",
    ) as CallRow[] | null;
    call = rows?.[0] ?? null;
  }
  if (!call) throw new ApiError("not_found", "That call wasn't found.");
  if (!holdsCall(c.userId, call)) throw new ApiError("not_your_call");
  return call;
}

interface DeviceRow {
  platform: string;
  build_type: string | null;
  push_token: string | null;
}

/**
 * The identity to ring, or null when the person has no device of that kind signed in. A phone
 * counts once it has registered for notifications (phone_devices with a push token); the
 * computer, once the extension has registered at all. iPhone development builds take calls on
 * <identity>_dev (routes/token.ts), so a person whose only phone is one rings that.
 */
function targetIdentity(userId: string, generation: number, to: HandoffTo, rows: DeviceRow[]): string | null {
  if (to === "chrome") return rows.some((r) => r.platform === "chrome") ? toIdentity(userId, generation) : null;
  const phones = rows.filter((r) => (r.platform === "android" || r.platform === "ios") && !!r.push_token);
  if (!phones.length) return null;
  return toIdentity(userId, generation, phones.every((r) => r.platform === "ios" && r.build_type === "dev"));
}

const NO_DEVICE: Record<HandoffTo, string> = {
  mobile: "Your phone isn't signed in to My Synergy Phone.",
  chrome: "My Synergy Phone isn't signed in on your computer.",
};

// ── POST /calls/:id/handoff ─────────────────────────────────────────────────────────

export async function startHandoff(env: Env, ec: Ctx, req: Request, idParam: string): Promise<Response> {
  const c = await requireCaller(env, req);
  // Workstream 2, phase 5: this business's Twilio account (its sub-account's, or the parent's).
  env = await callerTwilioEnv(env, c);
  const body = await readJson(req);
  const to = body.to;
  if (!isHandoffTo(to)) throw new ApiError("bad_request", "Pick where to move the call.");
  const legSid = String(body.leg_sid ?? "");
  if (!CALL_SID_RE.test(legSid)) throw new ApiError("bad_request", "Say which leg of the call this device is on.");

  const call = await myCall(c, idParam);
  // Only the device holding the call may move it (its own leg), so another device of the same
  // person, or a stale screen, cannot pull the call away from the one that has it.
  if (call.client_call_sid !== legSid) throw new ApiError("not_your_call");
  if (call.status !== "in_progress" || call.ended_at) throw new ApiError("not_live");
  if (!call.twilio_call_sid) throw new ApiError("not_live", "This call can't be moved yet. Try again in a moment.");
  if (call.is_emergency) throw new ApiError("emergency");
  if (call.transfer_state === "transferring") throw new ApiError("transfer_in_progress");
  if (switchUnderWay(call)) throw new ApiError("handoff_in_progress");

  const [callback, warm, devices] = await Promise.all([
    inEmergencyCallbackWindow(c.admin, call),
    call.transfer_state === "conference" ? warmStates(c.admin, [call]) : Promise.resolve(null),
    c.admin.from("phone_devices").select("platform, build_type, push_token").eq("user_id", c.userId).eq("client_id", c.ctx.client_id),
  ]);
  // A move can end in voicemail no more than Hold can, but the 911 rule is "nothing that could"
  // (conference.ts EMERGENCY_CALLBACK), and the person can simply stay where they are.
  if (callback) throw new ApiError("emergency", "For an hour after a 911 call from this number, its calls can't be moved.");
  if (warm?.get(call.id)?.state === "ringing") throw new ApiError("transfer_in_progress", "A teammate is being rung into this call. Wait for them to answer.");
  const identity = targetIdentity(c.userId, c.ctx.device_generation, to, (must(devices, "read devices") as DeviceRow[] | null) ?? []);
  if (!identity) throw new ApiError("no_target_device", NO_DEVICE[to]);

  // Before the claim: two Twilio reads at most, and nothing to undo if they fail.
  const held = await customerHeldNow(env, c.admin, call);

  // The claim: one at a time, from the leg that holds the call, on a live call.
  const key = crypto.randomUUID();
  const now = Date.now();
  const claimed = must(
    await c.admin.from("phone_calls").update({
      handoff_state: "ringing", handoff_to: to, handoff_key: key, handoff_at: iso(now), handoff_sid: null, handoff_from_sid: legSid,
    }).eq("id", call.id).eq("client_call_sid", legSid).eq("status", "in_progress").is("ended_at", null)
      .or(`handoff_state.is.null,handoff_at.lt.${iso(now - HANDOFF_WINDOW_MS)}`).select("id"),
    "claim handoff",
  ) as { id: string }[] | null;
  if (!claimed?.length) throw new ApiError("handoff_in_progress");
  // Written before the ring, so a fast 'missed' can never be older than its 'offered'
  // (GET /calls/:id/handoff reads the latest). `held` is what GET /handoff/pending offers.
  await addCallEvent(c.admin, call.id, DEVICE_SWITCH, { phase: "offered", to, held, user: c.userId });

  if (to === "mobile") {
    const builderNumber = call.direction === "in" ? call.to_e164 : call.from_e164;
    let sid: string;
    try {
      sid = await createCall(env, {
        to: `client:${identity}?${new URLSearchParams(handoffParams(call, key, held))}`,
        from: builderNumber,
        url: hook(env, "/voice/handoff", { call: call.id, k: key }),
        timeout: MOBILE_RING_SECONDS,
        statusCallback: hook(env, "/voice/status", { call: call.id, leg: "handoff" }),
      });
    } catch (e) {
      // Nothing rang and nothing changed: release the claim and say so.
      await c.admin.from("phone_calls").update({ handoff_state: null }).eq("id", call.id).eq("handoff_key", key).eq("handoff_state", "ringing");
      await addCallEvent(c.admin, call.id, DEVICE_SWITCH, { phase: "failed", to, reason: "ring_failed", user: c.userId });
      const te = e as TwilioError;
      ec.waitUntil(logFault({
        code: "handoff_ring_failed", clientId: c.ctx.client_id, context: { callId: call.id },
        message: `Ringing the person's phone to move a call failed (HTTP ${te?.status ?? 0}, code ${te?.code ?? 0}).`,
      }));
      throw new ApiError("ring_failed");
    }
    // Remembered so a cancel can stop the ring and only this leg may answer. Not ringing any
    // more by now: answered (fine), or missed or canceled before Twilio's answer reached us, in
    // which case the ring is stopped here.
    const stored = must(
      await c.admin.from("phone_calls").update({ handoff_sid: sid })
        .eq("id", call.id).eq("handoff_key", key).eq("handoff_state", "ringing").select("id"),
      "store handoff ring",
    ) as { id: string }[] | null;
    if (!stored?.length) {
      const now2 = await callById(c.admin, call.id);
      if (!(now2?.handoff_key === key && now2.handoff_state === "connecting")) {
        ec.waitUntil(updateCall(env, sid, { Status: "canceled" }).catch(() => {}));
      }
    }
  }
  return ok({ state: "ringing", key, to, call_id: call.id });
}

// ── POST /calls/:id/handoff/cancel ──────────────────────────────────────────────────

/** Which app is asking, the way /sms/send tells (x-sss-client, else the extension's origin). */
function whichApp(req: Request): "extension" | "mobile" {
  const hinted = (req.headers.get("x-sss-client") ?? "").toLowerCase();
  if (hinted === "extension" || hinted === "mobile") return hinted;
  return (req.headers.get("origin") ?? "").startsWith("chrome-extension://") ? "extension" : "mobile";
}

export async function cancelHandoff(env: Env, req: Request, idParam: string): Promise<Response> {
  const c = await requireCaller(env, req);
  // Workstream 2, phase 5: this business's Twilio account (its sub-account's, or the parent's).
  env = await callerTwilioEnv(env, c);
  const body = await readJson(req);
  const key = String(body.key ?? "");
  if (!UUID_RE.test(key)) throw new ApiError("bad_request", "That move isn't valid.");
  const call = await myCall(c, idParam, true);
  // Either device: the one that asked giving up, or the one being rung saying no (the
  // computer's "Leave on phone", the phone's "Leave on computer", which cancels before it
  // rejects the ring). Both are phase 'canceled', as the build contract has it: the device that
  // asked stops its own watch when it cancels, so a 'canceled' it reads is always the other
  // device's no, and the apps word it that way ("The call stayed on this phone."). data.reason
  // tells the two apart. A phone ring declined through Twilio alone ends busy and is 'missed'
  // (/voice/status?leg=handoff).
  const app = whichApp(req);
  const declined = (call.handoff_to === "chrome" && app === "extension") || (call.handoff_to === "mobile" && app === "mobile");
  if (call.handoff_key === key
    && await cancelRing(env, c.admin, call, key, { reason: declined ? "declined" : "canceled", user: c.userId })) {
    return ok({ state: "canceled", call_id: call.id });
  }
  // Nothing ringing under that key: say how it stands (answered and connecting, done, ...).
  const now = (await callById(c.admin, call.id)) ?? call;
  return ok({ ...(await moveStateOf(c.admin, now)), call_id: call.id });
}

// ── GET /calls/:id/handoff ──────────────────────────────────────────────────────────

export async function handoffStatus(env: Env, req: Request, idParam: string): Promise<Response> {
  const c = await requireCaller(env, req);
  const call = await myCall(c, idParam, true);
  return ok({ ...(await moveStateOf(c.admin, call)), call_id: call.id });
}

// ── GET /handoff/pending?for=chrome ─────────────────────────────────────────────────

type PendingRow = CallRow & { crm_contacts: { name: string | null } | { name: string | null }[] | null };

/**
 * The computer's ring: a move to this kind of device, ringing, under 45 s old, on a call the
 * caller holds. The extension asks on every realtime event about a call and on its minute
 * health check. The newest wins if there were ever two (two calls at once).
 */
export async function pendingHandoff(env: Env, req: Request): Promise<Response> {
  const c = await requireCaller(env, req);
  const forDevice = new URL(req.url).searchParams.get("for") ?? "chrome";
  if (!isHandoffTo(forDevice)) throw new ApiError("bad_request", "Say which device is asking.");
  const now = Date.now();
  const rows = (must(
    await c.admin.from("phone_calls").select(`${CALL_COLUMNS}, crm_contacts(name)`)
      .eq("client_id", c.ctx.client_id).eq("handoff_state", "ringing").eq("handoff_to", forDevice)
      .gt("handoff_at", iso(now - HANDOFF_WINDOW_MS)).or(`answered_by.eq.${c.userId},placed_by.eq.${c.userId}`)
      .order("handoff_at", { ascending: false }).limit(5),
    "read pending handoff",
  ) as PendingRow[] | null) ?? [];
  const row = rows.find((r) => holdsCall(c.userId, r) && r.status === "in_progress" && !r.ended_at && !!r.handoff_key && switchUnderWay(r, now));
  if (!row) return ok({ offer: null });

  const [events, visible] = await Promise.all([
    switchEvents(c.admin, row.id),
    row.contact_id ? visibleContactIds(c, [row.contact_id]) : Promise.resolve(new Set<string>()),
  ]);
  const offered = events.find((e) => e.data?.phase === "offered");
  const contact = Array.isArray(row.crm_contacts) ? row.crm_contacts[0] ?? null : row.crm_contacts;
  return ok({
    offer: {
      call_id: row.id,
      key: row.handoff_key,
      customer_e164: customerOf(row) || null,
      contact_id: row.contact_id,
      // Only a contact this person may see by name; the number is theirs either way (they are on the call).
      contact_name: row.contact_id && visible.has(row.contact_id) ? contact?.name ?? null : null,
      direction: row.direction,
      answered_at: row.answered_at,
      held: offered?.data?.held === true,
      expires_at: iso(Date.parse(row.handoff_at!) + HANDOFF_WINDOW_MS),
    },
  });
}
