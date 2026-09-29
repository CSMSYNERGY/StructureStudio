// /calls/:id/transfer, /calls/:id/events and /voicemails/:id/audio. (Hold, resume and warm
// transfer are in ./conference.ts.)
//
// `:id` is the phone_calls id. It may also be a Twilio CallSid: an inbound call hands the app
// its id as the call_id custom parameter, but an outbound call cannot receive parameters, so the
// app only knows its own leg's CallSid there (the id then resolves through client_call_sid).

import type { Ctx, Env } from "../env";
import { requireCaller, type Caller } from "../context";
import { addCallEvent, CALL_COLUMNS, callerContext, must, routeForNumber, type CallRow } from "../db";
import { ApiError, CALL_SID_RE, ok, readJson, UUID_RE } from "../http";
import { toIdentity } from "../identity";
import { logFault } from "../log";
import { callIsMine, isTeamLevel, mayReadUnknownNumbers, visibleContactIds } from "../scope";
import { nextTransferState, onTheCall, refuseEmergencyCallback, transferParams } from "../conference";
import { clientNoun, dial, response } from "../twiml";
import { recordingMedia, TwilioError, updateCall } from "../twilioRest";
import { hook } from "../urls";
import { voicemailTwiml } from "../voicemail";
import { onDnd } from "./voice";

/** The call, on the caller's own tenant, by id or by either leg's CallSid. */
export async function resolveCall(c: Caller, idOrSid: string): Promise<CallRow | null> {
  let q = c.admin.from("phone_calls").select(CALL_COLUMNS).eq("client_id", c.ctx.client_id);
  if (UUID_RE.test(idOrSid)) q = q.eq("id", idOrSid);
  else if (CALL_SID_RE.test(idOrSid)) q = q.or(`client_call_sid.eq.${idOrSid},twilio_call_sid.eq.${idOrSid}`);
  else return null;
  const rows = must(await q.limit(1), "resolve call") as CallRow[] | null;
  return rows?.[0] ?? null;
}

function involves(userId: string, call: CallRow): boolean {
  return call.placed_by === userId || call.answered_by === userId || call.transferred_from === userId
    || (call.rang_user_ids ?? []).includes(userId);
}

// ── POST /calls/:id/transfer ────────────────────────────────────────────────────────

/**
 * Cold transfer (plan 9C). Marks the call as transferring FIRST, so the original Dial's
 * after-dial (step 1) knows to stand aside, then redirects the CUSTOMER's leg to a 20-second
 * Dial to the teammate's app identity with after-dial?transfer=1 as the safety net: no answer,
 * a decline, DND or no device online all end in voicemail, never a hang-up and never the
 * teammate's personal cell. Your own leg is ended only after the redirect succeeded; if it
 * failed, the row is put back and you are still on the call.
 */
export async function transfer(env: Env, ec: Ctx, req: Request, idParam: string): Promise<Response> {
  const c = await requireCaller(env, req);
  const body = await readJson(req);
  const target = String(body.to_user_id ?? "");
  if (!UUID_RE.test(target)) throw new ApiError("bad_request", "Pick a teammate to transfer to.");
  if (target === c.userId) throw new ApiError("bad_request", "You can't transfer a call to yourself.");

  const call = await resolveCall(c, idParam);
  if (!call) throw new ApiError("not_found", "That call wasn't found.");
  // Whoever is on the call now: the one who answered (inbound, or a transfer they took), the
  // one who placed an outbound call that has not been handed on yet, or (in a conference) the
  // one who handed it on by warm transfer.
  if (!onTheCall(c.userId, call)) throw new ApiError("not_found", "Only the person on the call can transfer it.");
  if (call.status !== "in_progress" || call.ended_at) throw new ApiError("bad_request", "That call has already ended.");
  // From a plain call or from its conference (hold / warm transfer). Redirecting the customer
  // out of the conference ends it for everyone else, which is what a cold transfer does anyway.
  const step = nextTransferState(call.transfer_state, "cold");
  if (!step.ok) throw new ApiError("bad_request", step.message);
  const fromConference = call.transfer_state === "conference";
  const customerLeg = call.twilio_call_sid;
  const myLeg = call.client_call_sid;
  if (!customerLeg) throw new ApiError("bad_request", "This call can't be transferred yet. Try again in a moment.");

  const builderNumber = call.direction === "in" ? call.to_e164 : call.from_e164;
  const [tctx, tset, info] = await Promise.all([
    callerContext(c.admin, target),
    c.admin.from("phone_user_settings").select("dnd, dnd_until").eq("user_id", target).maybeSingle(),
    routeForNumber(c.admin, builderNumber),
  ]);
  await refuseEmergencyCallback(c.admin, call, info);
  if (!tctx || tctx.client_id !== c.ctx.client_id || tctx.phone_level === "none") {
    throw new ApiError("not_found", "That teammate can't take calls.");
  }
  const tdnd = (tset.data ?? null) as { dnd?: boolean; dnd_until?: string | null } | null;
  const targetOnDnd = !!tdnd && onDnd({ dnd: tdnd.dnd === true, dnd_until: tdnd.dnd_until ?? null });

  // 1. Mark it, conditionally, so two presses cannot both win.
  const rang = [...new Set([...(call.rang_user_ids ?? []), target])];
  const mark = c.admin.from("phone_calls").update({
    transfer_state: "transferring", transferred_from: c.userId, answered_by: null, client_call_sid: null,
    rang_user_ids: rang,
  }).eq("id", call.id);
  const claimed = must(
    await (fromConference ? mark.eq("transfer_state", "conference") : mark.is("transfer_state", null)).select("id"),
    "mark transfer",
  ) as { id: string }[] | null;
  if (!claimed?.length) throw new ApiError("bad_request", "A transfer is already under way.");

  // 2. Redirect the customer's leg.
  const xml = targetOnDnd
    // On DND: the teammate is not rung at all; the customer goes to the builder's voicemail.
    ? voicemailTwiml(env, call.id, info)
    : response(dial({
      timeout: 20,
      action: hook(env, "/voice/after-dial", { call: call.id, transfer: 1 }),
    }, [clientNoun({
      identity: toIdentity(target, tctx.device_generation),
      statusCallback: hook(env, "/voice/status", { call: call.id, leg: "client" }),
      params: transferParams(call, c.userId),
    })]));
  try {
    await updateCall(env, customerLeg, { Twiml: xml });
  } catch (e) {
    // Put the row back: the call is still yours, and after-dial must not stand aside.
    await c.admin.from("phone_calls").update({
      transfer_state: call.transfer_state, transferred_from: call.transferred_from, answered_by: call.answered_by,
      client_call_sid: myLeg, rang_user_ids: call.rang_user_ids,
    }).eq("id", call.id);
    const te = e as TwilioError;
    ec.waitUntil(logFault({
      code: "transfer_failed", clientId: c.ctx.client_id,
      message: `Redirecting the customer's leg failed (HTTP ${te.status ?? 0}, code ${te.code ?? 0}).`,
      context: { callId: call.id },
    }));
    throw new ApiError("twilio_error", "The transfer didn't go through. You're still on the call.");
  }

  // 3. Only now end your own leg (usually already gone: leaving the Dial ends it).
  if (myLeg) {
    ec.waitUntil(updateCall(env, myLeg, { Status: "completed" }).catch(() => {}));
  }
  ec.waitUntil(addCallEvent(c.admin, call.id, "transfer", { from: c.userId, to: target, dnd: targetOnDnd }));
  return ok();
}

// ── POST /calls/:id/events ──────────────────────────────────────────────────────────

const EVENT_TYPE_RE = /^[a-z][a-z0-9_]{0,39}$/;

export async function events(env: Env, req: Request, idParam: string): Promise<Response> {
  const c = await requireCaller(env, req, { needOn: false });
  const body = await readJson(req);
  const type = String(body.type ?? "");
  if (!EVENT_TYPE_RE.test(type)) throw new ApiError("bad_request", "Unknown event type.");
  const atMs = Number(body.at_ms);
  if (!Number.isFinite(atMs) || Math.abs(Date.now() - atMs) > 86_400_000) {
    throw new ApiError("bad_request", "The event time is missing or too far off.");
  }
  let data: Record<string, unknown> | null = null;
  if (body.data !== undefined && body.data !== null) {
    if (typeof body.data !== "object" || Array.isArray(body.data)) throw new ApiError("bad_request", "Event data must be an object.");
    if (JSON.stringify(body.data).length > 4000) throw new ApiError("bad_request", "Event data is too large.");
    data = body.data as Record<string, unknown>;
  }
  const call = await resolveCall(c, idParam);
  if (!call || !involves(c.userId, call)) throw new ApiError("not_found", "That call wasn't found.");
  await addCallEvent(c.admin, call.id, type, { ...(data ?? {}), source: "app", user: c.userId }, new Date(atMs).toISOString());
  return ok();
}

// ── GET /voicemails/:id/audio ───────────────────────────────────────────────────────

/** May this caller see this call? Phone level, "mine", and the contacts row scope. */
export async function mayViewCall(c: Caller, call: CallRow): Promise<boolean> {
  if (call.client_id !== c.ctx.client_id) return false;
  let owner: string | null = null;
  if (call.contact_id) {
    const visible = await visibleContactIds(c, [call.contact_id]);
    if (!visible.has(call.contact_id)) return false;
    const row = must(await c.admin.from("crm_contacts").select("owner_user_id").eq("id", call.contact_id).maybeSingle(), "read contact owner") as { owner_user_id: string | null } | null;
    owner = row?.owner_user_id ?? null;
  } else if (!mayReadUnknownNumbers(c.ctx) && !involves(c.userId, call)) {
    return false;
  }
  if (isTeamLevel(c.ctx.phone_level)) return true;
  return callIsMine(c.userId, { ...call, contact_owner: owner }) || call.transferred_from === c.userId;
}

export async function voicemailAudio(env: Env, ec: Ctx, req: Request, id: string): Promise<Response> {
  // ?access_token= stays for installed extension builds only (checked 2026-09-29). Today's
  // apps send the header only: the extension fetches the bytes and plays them from a blob: URL,
  // the mobile app hands the header to expo-audio, and phone-core no longer builds a URL with
  // the token in it. Extension builds installed before 2026-09-29 still play voicemail through
  // <audio src> with the token in the query. Drop this once those builds are gone (SPEC
  // section 3); nothing in the code is left to change first.
  const c = await requireCaller(env, req, { allowQueryToken: true, needOn: false });
  if (!UUID_RE.test(id)) throw new ApiError("not_found", "That voicemail wasn't found.");
  const vm = must(
    await c.admin.from("phone_voicemails").select("id, call_id, client_id, recording_sid, deleted_at, listened_at").eq("id", id).maybeSingle(),
    "read voicemail",
  ) as { id: string; call_id: string; client_id: string; recording_sid: string | null; deleted_at: string | null; listened_at: string | null } | null;
  if (!vm || vm.client_id !== c.ctx.client_id || vm.deleted_at || !vm.recording_sid) {
    throw new ApiError("not_found", "That voicemail wasn't found.");
  }
  const call = must(await c.admin.from("phone_calls").select(CALL_COLUMNS).eq("id", vm.call_id).maybeSingle(), "read call") as CallRow | null;
  if (!call || !(await mayViewCall(c, call))) throw new ApiError("not_found", "That voicemail wasn't found.");

  let media: Response;
  try {
    media = await recordingMedia(env, vm.recording_sid, req.headers.get("range"));
  } catch {
    throw new ApiError("twilio_error", "The voicemail couldn't be loaded. Please try again.");
  }
  if (media.status === 404) throw new ApiError("not_found", "That voicemail is no longer available.");
  if (!media.ok) throw new ApiError("twilio_error", "The voicemail couldn't be loaded. Please try again.");

  if (!vm.listened_at) {
    ec.waitUntil((async () => {
      await c.admin.from("phone_voicemails").update({ listened_at: new Date().toISOString(), listened_by: c.userId })
        .eq("id", vm.id).is("listened_at", null);
    })());
  }
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
