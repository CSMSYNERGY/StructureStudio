// Twilio's call webhooks: /voice/outbound, /voice/inbound, /voice/after-dial, /voice/screen,
// /voice/status, /voice/voicemail and /voice/transcription. The router has already checked
// ?key= (and the signature, when TWILIO_AUTH_TOKEN is set). The conference callback
// (/voice/conference) and hold / warm transfer live in ../conference.ts; the voicemail TwiML in
// ../voicemail.ts.
//
// SPEED RULES (plan sections 2 and 8). Twilio waits for these answers before anyone hears a
// ring, so each one makes the fewest possible round trips, uncached, and everything that is not
// needed for the answer (the phone_calls row, timing marks, status writes) goes to waitUntil.
// The phone_calls id is generated here rather than returned by an insert, so the TwiML can name
// it before the row exists; the status writer tolerates arriving first (withCallRow).

import type { Ctx, Env } from "../env";
import { intVar } from "../env";
import {
  addCallEvent, adminClient, callById, callerContext, must, patchCall, routeForNumber,
  type Admin, type CallRow, type RouteInfo, type RouteMember,
} from "../db";
import { conferenceTwiml, holderLegEnded, warmLegStatus } from "../conference";
import { endRingWithCall, goneTwiml, handoffAnswer, handoffLegStatus, holdsCall } from "../handoff";
import { UUID_RE } from "../http";
import { isOpen } from "../hours";
import { emergencyDigits, isPremiumRate, parseIdentity, phoneDigits, stripClientPrefix, toE164, toIdentity, type ParsedIdentity } from "../identity";
import { logFault } from "../log";
import type { TwilioParams } from "../twilioSignature";
import {
  clientNoun, dial, gather, hangup, numberNoun, response, say,
} from "../twiml";
import { hook } from "../urls";
import { voicemailTwiml } from "../voicemail";
import { requestAutoTopup, WALLET_WORDS, walletFloorCheck } from "../wallet";

/** Twilio allows at most 10 nouns in one <Dial>. */
const MAX_NOUNS = 10;
/** A recording shorter than this is a hang-up at the beep, not a message. */
export const MIN_VOICEMAIL_SECONDS = 1;
/** Rounds of re-ringing the 911 caller before giving up (never voicemail, but never forever). */
const EMERGENCY_ROUNDS = 10;
/** Outbound ring time: long enough for the customer's own voicemail to pick up. */
const OUTBOUND_TIMEOUT = 60;

export const SAY = {
  emergency: "For emergencies, call 9 1 1 from your cell phone.",
  noAccess: "Your account doesn't have phone access. Ask your owner to turn it on.",
  retired: "This device was signed out. Please sign in again.",
  phoneOff: "My Synergy Phone isn't switched on for your business yet.",
  noNumber: "Your business doesn't have a phone number yet.",
  badNumber: "That number can't be dialed. Check it and try again.",
  premium: "That number can't be dialed from My Synergy Phone.",
  notYourContact: "That contact isn't in your account.",
  minuteCap: "Today's calling limit is reached. It resets tomorrow.",
  badIdentity: "My Synergy Phone isn't signed in correctly. Please sign out and back in.",
  notInService: "Sorry, this number can't take calls right now. Please try again later.",
  // The wallet floor's two refusals (wallet.ts): auto top-up on, or not.
  walletEmpty: WALLET_WORDS.empty,
  walletToppingUp: WALLET_WORDS.toppingUp,
  thanks: "Thank you. Goodbye.",
} as const;

// ── small helpers ────────────────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

function twilioTime(p: TwilioParams): string {
  const t = p.Timestamp ? Date.parse(p.Timestamp) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : nowIso();
}

/** An effective DND: the flag, unless its end time has passed. */
export function onDnd(m: { dnd: boolean; dnd_until?: string | null }, now = Date.now()): boolean {
  if (!m.dnd) return false;
  if (m.dnd_until) {
    const until = Date.parse(m.dnd_until);
    if (Number.isFinite(until) && until <= now) return false;
  }
  return true;
}

/** Route members who may ring right now, in the owner's order. */
export function availableMembers(info: RouteInfo, now = Date.now()): RouteMember[] {
  const order = info.route.members;
  const pos = (id: string) => {
    const i = order.indexOf(id);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  return info.members
    .filter((m) => m.has_access && !m.busy && !onDnd(m, now))
    .sort((a, b) => pos(a.user_id) - pos(b.user_id));
}

function screenUrl(env: Env, callId: string, business: string | null, userId?: string): string {
  return hook(env, "/voice/screen", { call: callId, user: userId, b: (business ?? "").slice(0, 60) });
}

/** One <Client> for the member, and their cell (screened) when they chose forwarding. */
function memberNouns(env: Env, callId: string, m: { user_id: string; identity: string; forward_to_cell: string | null }, business: string | null): string[] {
  const nouns = [clientNoun({
    identity: m.identity,
    statusCallback: hook(env, "/voice/status", { call: callId, leg: "client" }),
    params: { call_id: callId },
  })];
  const cell = toE164(m.forward_to_cell);
  if (cell) {
    nouns.push(numberNoun({
      e164: cell,
      url: screenUrl(env, callId, business, m.user_id),
      statusCallback: hook(env, "/voice/status", { call: callId, leg: "cell", user: m.user_id }),
    }));
  }
  return nouns;
}

/** Forward to the route's number, screened; a forward nobody takes ends in voicemail. */
function forwardTwiml(env: Env, callId: string, info: RouteInfo, forwardTo: string): string {
  return response(dial({
    timeout: info.route.ring_seconds,
    action: hook(env, "/voice/after-dial", { call: callId, stage: "fwd" }),
  }, [numberNoun({
    e164: forwardTo,
    url: screenUrl(env, callId, info.business_name),
    statusCallback: hook(env, "/voice/status", { call: callId, leg: "cell" }),
  })]));
}

async function contactIdForNumber(admin: Admin, clientId: string, e164: string): Promise<string | null> {
  const digits = phoneDigits(e164);
  if (!digits) return null;
  const { data, error } = await admin.from("crm_contacts").select("id")
    .eq("client_id", clientId).eq("phone_digits", digits).is("merged_into", null)
    .order("updated_at", { ascending: false }).limit(1).maybeSingle();
  if (error) {
    console.warn(`[phone-api] contact lookup failed: ${error.message}`);
    return null;
  }
  return (data as { id?: string } | null)?.id ?? null;
}

/** Insert a phone_calls row, then its first timing marks. Runs in waitUntil. */
async function insertCall(admin: Admin, row: Record<string, unknown>, events: { type: string; data: Record<string, unknown> | null; at?: string }[]): Promise<void> {
  const { error } = await admin.from("phone_calls").insert(row);
  if (error) {
    await logFault({
      code: "phone_call_insert_failed",
      message: `phone_calls insert failed: ${error.message}`,
      clientId: String(row.client_id ?? ""),
      context: { callId: row.id, direction: row.direction, pg: error.code ?? null },
    });
    return;
  }
  for (const e of events) await addCallEvent(admin, String(row.id), e.type, e.data, e.at);
}

/** The status and voicemail writers can arrive before the background insert lands. */
async function withCallRow(admin: Admin, id: string, tries = 4): Promise<CallRow | null> {
  for (let i = 0; i < tries; i++) {
    const row = await callById(admin, id);
    if (row) return row;
    if (i < tries - 1) await new Promise((r) => setTimeout(r, 150 * 2 ** i));
  }
  return null;
}

// ── /voice/outbound ──────────────────────────────────────────────────────────────────

/**
 * The most a call can still be going for: Twilio's default <Dial> timeLimit (4 hours), the same
 * bound phone_route_for_number puts on 'busy' (migration 254 DEVIATION 2) for the same reason.
 */
const MAX_LIVE_CALL_MINUTES = 240;

/** Outbound minutes today (UTC), rounded up per call the way Twilio bills. */
async function minutesUsedToday(admin: Admin, clientId: string, now = new Date()): Promise<number> {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const rows = must(
    await admin.from("phone_calls").select("duration_s, answered_at, ended_at")
      .eq("client_id", clientId).eq("direction", "out").gte("started_at", start).limit(1000),
    "count outbound minutes",
  ) as { duration_s: number | null; answered_at: string | null; ended_at: string | null }[] | null;
  let minutes = 0;
  for (const r of rows ?? []) {
    if (typeof r.duration_s === "number" && r.duration_s > 0) minutes += Math.ceil(r.duration_s / 60);
    else if (r.answered_at && !r.ended_at) {
      // A call still going counts for what it has used so far. A row whose final status
      // callback was lost never gets ended_at; uncapped, it would keep "using" a minute a minute
      // until midnight UTC and lock the builder out of calling (600 minutes is 10 hours).
      const ms = now.getTime() - Date.parse(r.answered_at);
      if (Number.isFinite(ms) && ms > 0) minutes += Math.min(MAX_LIVE_CALL_MINUTES, Math.ceil(ms / 60_000));
    }
  }
  return minutes;
}

/**
 * The computer answering a move of a live call to it (../handoff.ts): the extension's
 * device.connect({To:'handoff', HandoffCall, HandoffKey}). Not an outbound call at all, so it
 * is answered here, before every outbound rule: no phone_calls row (the call has one), no daily
 * minute cap and no wallet floor (the call is already paid for as it goes). The caller is
 * re-checked as every outbound call is (team, generation, the switch), and must hold the call.
 */
async function handoffOutbound(env: Env, ec: Ctx, p: TwilioParams, identity: ParsedIdentity): Promise<string> {
  const callId = String(p.HandoffCall ?? "").trim();
  const key = String(p.HandoffKey ?? "").trim();
  if (!UUID_RE.test(callId) || !UUID_RE.test(key)) return goneTwiml();
  const admin = adminClient(env);
  const [ctx, call] = await Promise.all([callerContext(admin, identity.userId), callById(admin, callId)]);
  if (!ctx || ctx.phone_level === "none") return response(say(SAY.noAccess), hangup());
  if (ctx.device_generation !== identity.generation) return response(say(SAY.retired), hangup());
  if (ctx.phone_status !== "on") return response(say(SAY.phoneOff), hangup());
  if (!call || call.client_id !== ctx.client_id || !holdsCall(identity.userId, call)) return goneTwiml();
  return handoffAnswer(env, ec, call, key, String(p.CallSid ?? ""), "chrome");
}

export async function outbound(env: Env, ec: Ctx, p: TwilioParams, t0: number): Promise<string> {
  const identity = parseIdentity(stripClientPrefix(p.From ?? ""));
  if (!identity) return response(say(SAY.badIdentity), hangup());
  // A device switch, not a call to anyone: answered before the 911 check and every outbound
  // rule below (handoffOutbound).
  if (p.HandoffCall !== undefined || p.HandoffKey !== undefined) return handoffOutbound(env, ec, p, identity);
  const admin = adminClient(env);
  const rawTo = String(p.To ?? "").trim();

  // ── 911 / 933 / 112 ─────────────────────────────────────────────────────────────────
  const emergency = emergencyDigits(rawTo);
  if (emergency) {
    const allow = env.EMERGENCY_MODE === "allow" && (emergency === "911" || emergency === "933");
    // The caller id must be a number with a registered emergency address (phase 6); without
    // a number there is nothing to put a location on, so it is refused the pilot way. In block
    // mode the lookup happens after the answer: the refusal needs nothing from the database.
    const ctxP = callerContext(admin, identity.userId);
    const ctx = allow ? await ctxP : null;
    if (allow && ctx?.number) {
      // Skips every block below: team, generation, the switch, the minute cap, the wallet.
      // The digits go to Twilio as dialed, never rewritten into +1 format.
      const callId = crypto.randomUUID();
      ec.waitUntil(insertCall(admin, {
        id: callId, client_id: ctx.client_id, number_id: ctx.number.id, direction: "out",
        from_e164: ctx.number.e164, to_e164: emergency, client_call_sid: p.CallSid ?? null,
        placed_by: identity.userId, status: "ringing", is_emergency: true,
      }, [{ type: "twiml_served", data: { ms: Date.now() - t0, emergency: true } }]));
      return response(dial({ answerOnBridge: true, callerId: ctx.number.e164 }, [
        numberNoun({ e164: emergency, statusCallback: hook(env, "/voice/status", { call: callId, leg: "pstn" }) }),
      ]));
    }
    ec.waitUntil((async () => {
      const who = await ctxP.catch(() => null);
      if (who?.client_id) {
        await insertCall(admin, {
          id: crypto.randomUUID(), client_id: who.client_id, number_id: who.number?.id ?? null, direction: "out",
          from_e164: who.number?.e164 ?? "unknown", to_e164: emergency, client_call_sid: p.CallSid ?? null,
          placed_by: identity.userId, status: "failed", error_code: "emergency_blocked", ended_at: nowIso(),
          // NOT is_emergency: nothing reached a dispatcher, so no callback is coming, and the
          // 60-minute "ring only this person" rule must not switch on for a blocked attempt.
          is_emergency: false,
        }, []);
      }
      await logFault({
        code: "emergency_blocked", severity: "warn", clientId: who?.client_id ?? null,
        message: `An emergency number (${emergency}) was dialed and refused: EMERGENCY_MODE is ${env.EMERGENCY_MODE || "block"}.`,
        context: { userId: identity.userId },
      });
    })());
    return response(say(SAY.emergency), hangup());
  }

  // ── Who is calling, re-checked uncached on every call ──────────────────────────────
  const ctx = await callerContext(admin, identity.userId);
  if (!ctx || ctx.phone_level === "none") return response(say(SAY.noAccess), hangup());
  if (ctx.device_generation !== identity.generation) return response(say(SAY.retired), hangup());
  if (ctx.phone_status !== "on") return response(say(SAY.phoneOff), hangup());
  if (!ctx.number) return response(say(SAY.noNumber), hangup());

  const to = rawTo.startsWith("client:") ? null : toE164(rawTo);
  if (!to) return response(say(SAY.badNumber), hangup());
  if (isPremiumRate(to)) return response(say(SAY.premium), hangup());

  const contactParam = String(p.ContactId ?? "").trim();
  const refuse = (code: string, words: string) => {
    ec.waitUntil(insertCall(admin, {
      id: crypto.randomUUID(), client_id: ctx.client_id, number_id: ctx.number!.id, direction: "out",
      from_e164: ctx.number!.e164, to_e164: to, client_call_sid: p.CallSid ?? null,
      placed_by: identity.userId, status: "failed", error_code: code, ended_at: nowIso(),
    }, []));
    return response(say(words), hangup());
  };

  const cap = intVar(env.DAILY_MINUTE_CAP, 600, 0);
  // All in one parallel round: the contact's tenant, today's minutes, and the wallet floor
  // (wallet.ts: one RPC while PHONE_USAGE_METERS is on, none while it is off).
  const [contactOk, used, wallet] = await Promise.all([
    (async () => {
      if (!contactParam) return true;
      if (!UUID_RE.test(contactParam)) return false;
      const row = must(
        await admin.from("crm_contacts").select("id").eq("id", contactParam).eq("client_id", ctx.client_id).maybeSingle(),
        "check contact tenant",
      );
      return !!row;
    })(),
    cap > 0 ? minutesUsedToday(admin, ctx.client_id) : Promise.resolve(0),
    walletFloorCheck(env, admin, ctx.client_id),
  ]);
  // A contact id from another tenant (an operator's stale tab, or a forged param) is refused
  // outright, never dialed "without the contact".
  if (!contactOk) return refuse("not_your_customer", SAY.notYourContact);
  if (cap > 0 && used >= cap) {
    ec.waitUntil(logFault({
      code: "minute_cap", severity: "warn", clientId: ctx.client_id,
      message: `Daily outbound minute cap reached (${used} of ${cap}).`,
      throttleMs: 60 * 60_000,
    }));
    return refuse("minute_cap", SAY.minuteCap);
  }
  if (wallet.refuse) {
    ec.waitUntil(logFault({
      code: "wallet_empty", severity: "info", clientId: ctx.client_id, throttleMs: 60 * 60_000,
      message: `Outbound call refused: wallet ${wallet.availableCents} cents is below the floor of ${wallet.floorCents}.`,
    }));
    // Auto top-up on: ask for one now (after the answer; the edge function decides whether to
    // charge the card) and tell them to try again shortly. Same error_code either way.
    if (wallet.autoTopupEnabled) {
      ec.waitUntil(requestAutoTopup(env, ctx.client_id));
      return refuse("wallet_empty", SAY.walletToppingUp);
    }
    return refuse("wallet_empty", SAY.walletEmpty);
  }
  if (wallet.reason === "error") {
    // Fails OPEN: a billing read that failed must not stop a builder calling a customer.
    ec.waitUntil(logFault({
      code: "wallet_floor_check_failed", severity: "warn", clientId: ctx.client_id, throttleMs: 10 * 60_000,
      message: "The wallet floor could not be read; the call was allowed.",
    }));
  }

  const callId = crypto.randomUUID();
  const events: { type: string; data: Record<string, unknown> | null; at?: string }[] = [];
  const clickAt = Number(p.ClickAt);
  if (Number.isFinite(clickAt) && Math.abs(Date.now() - clickAt) < 86_400_000) {
    events.push({ type: "click", data: null, at: new Date(clickAt).toISOString() });
  }
  events.push({ type: "twiml_served", data: { ms: Date.now() - t0 } });
  ec.waitUntil(insertCall(admin, {
    id: callId, client_id: ctx.client_id, number_id: ctx.number.id,
    contact_id: contactParam || null, direction: "out",
    from_e164: ctx.number.e164, to_e164: to, client_call_sid: p.CallSid ?? null,
    placed_by: identity.userId, status: "ringing",
  }, events));

  // Caller ID is ALWAYS the builder's number, set here; the app has no say in it. The action
  // (stage=out) is what lets hold and warm transfer move this call into a conference (plan
  // 9C design b): when the customer's leg is redirected, the app's leg lands there. Every other
  // way this Dial ends, after-dial just hangs the app leg up, as before.
  return response(dial({
    answerOnBridge: true, callerId: ctx.number.e164, timeout: OUTBOUND_TIMEOUT,
    action: hook(env, "/voice/after-dial", { call: callId, stage: "out" }),
  }, [
    numberNoun({ e164: to, statusCallback: hook(env, "/voice/status", { call: callId, leg: "pstn" }) }),
  ]));
}

// ── /voice/inbound ───────────────────────────────────────────────────────────────────

/** The one member the 911 callback rule rings, with their identity and cell. */
async function emergencyTarget(admin: Admin, info: RouteInfo): Promise<{ user_id: string; identity: string; forward_to_cell: string | null } | null> {
  const id = info.recent_emergency_user;
  if (!id) return null;
  const m = info.members.find((x) => x.user_id === id);
  if (m) return { user_id: m.user_id, identity: m.identity, forward_to_cell: m.forward_to_cell };
  // Not a route member (anyone on the team can dial out): read their line directly.
  const { data } = await admin.from("phone_user_settings").select("device_generation, forward_to_cell").eq("user_id", id).maybeSingle();
  const s = data as { device_generation?: number; forward_to_cell?: string | null } | null;
  const gen = Number(s?.device_generation) >= 1 ? Number(s!.device_generation) : 1;
  return { user_id: id, identity: toIdentity(id, gen), forward_to_cell: s?.forward_to_cell ?? null };
}

function emergencyDial(env: Env, callId: string, info: RouteInfo, target: { user_id: string; identity: string; forward_to_cell: string | null }, round: number): string {
  return response(dial({
    timeout: info.route.ring_seconds,
    action: hook(env, "/voice/after-dial", { call: callId, stage: "er", n: round }),
  }, memberNouns(env, callId, target, info.business_name)));
}

/** One ring group: every available member at once, or (in_order) the one at `startAfter`+1. */
export function ringPlan(info: RouteInfo, now = Date.now(), startAfter = -1): { members: RouteMember[]; position: number } | null {
  const avail = availableMembers(info, now);
  if (!avail.length) return null;
  if (info.route.mode !== "in_order") return { members: avail, position: -1 };
  const order = info.route.members;
  for (const m of avail) {
    const pos = order.indexOf(m.user_id);
    if (pos > startAfter) return { members: [m], position: pos };
  }
  return null;
}

function ringTwiml(env: Env, callId: string, info: RouteInfo, plan: { members: RouteMember[]; position: number }): string {
  const nouns: string[] = [];
  for (const m of plan.members) {
    for (const n of memberNouns(env, callId, m, info.business_name)) {
      if (nouns.length < MAX_NOUNS) nouns.push(n);
    }
  }
  const action = info.route.mode === "in_order"
    ? hook(env, "/voice/after-dial", { call: callId, stage: "order", p: plan.position })
    : hook(env, "/voice/after-dial", { call: callId });
  return response(dial({ timeout: info.route.ring_seconds, action }, nouns));
}

export async function inbound(env: Env, ec: Ctx, p: TwilioParams, t0: number): Promise<string> {
  const admin = adminClient(env);
  const to = String(p.To ?? "");
  const from = String(p.From ?? "").slice(0, 40) || "unknown";
  const info = await routeForNumber(admin, to);
  if (!info) {
    ec.waitUntil(logFault({
      code: "inbound_unknown_number", severity: "warn", throttleMs: 10 * 60_000,
      message: "An inbound call reached a number with no sms_numbers row; its voice URL points here by mistake.",
    }));
    return response(say(SAY.notInService), hangup());
  }
  const emergencyUser = info.recent_emergency_user;
  const callId = crypto.randomUUID();
  let xml: string;
  let rang: string[] = [];

  if (!emergencyUser && info.phone_status !== "on") {
    // The switch is off (paused, or the SQL panic button) but the number still points here:
    // never drop the caller. Take a voicemail and keep the row, so the builder sees it when
    // calling is back on. Nobody's app rings. The 911 callback skips the switch, like every block.
    xml = voicemailTwiml(env, callId, info);
  } else if (emergencyUser) {
    // Plan section 14: for 60 minutes after a 911 call from this number, ring ONLY the person
    // who dialed it, ignoring DND and busy, and never go to voicemail (the dispatcher calling back).
    const target = await emergencyTarget(admin, info);
    xml = target ? emergencyDial(env, callId, info, target, 1) : voicemailTwiml(env, callId, info);
    rang = target ? [target.user_id] : [];
  } else if (!isOpen(info.route.business_hours, info.route.time_zone)) {
    const fwd = info.route.after_hours === "forward" ? toE164(info.route.forward_to) : null;
    xml = fwd ? forwardTwiml(env, callId, info, fwd) : voicemailTwiml(env, callId, info);
  } else {
    const plan = ringPlan(info);
    if (!plan) {
      // Everyone is off the team, without access, on DND or on a call: straight to voicemail.
      xml = voicemailTwiml(env, callId, info);
    } else {
      xml = ringTwiml(env, callId, info, plan);
      rang = plan.members.map((m) => m.user_id);
    }
  }

  // Measured now, before the background work below adds its own time to it.
  const servedMs = Date.now() - t0;
  ec.waitUntil((async () => {
    const contactId = await contactIdForNumber(admin, info.client_id, from);
    await insertCall(admin, {
      id: callId, client_id: info.client_id, number_id: info.number_id, contact_id: contactId,
      direction: "in", from_e164: from, to_e164: to, twilio_call_sid: p.CallSid ?? null,
      rang_user_ids: rang, status: "ringing",
    }, [{ type: "twiml_served", data: { ms: servedMs, rang: rang.length } }]);
  })());
  return xml;
}

// ── /voice/after-dial ────────────────────────────────────────────────────────────────

/**
 * Twilio calls this EVERY time a Dial with this action ends, answered or not, and possibly
 * when a call is redirected away from its Dial for a transfer.
 *
 * stage=out is the OUTBOUND Dial (the app's leg is the parent). It never rings anyone and
 * never goes to voicemail: in the conference state the app's leg joins the conference (its
 * customer was just moved there), otherwise it hangs up, which is what the Dial did before it
 * had an action.
 *
 * Every other Dial's parent is the customer. The order is plan section 8's, with step 0 added
 * for hold and warm transfer (9C design b):
 *   0. transfer_state = 'conference' → the child leg was moved into the call's conference:
 *      answer the customer with the same <Conference>. Never voicemail, never a hang-up;
 *   1. no transfer=1 on the request, but the call's transfer_state is set → the original Dial
 *      ended because the call was redirected for a transfer: empty response, change nothing;
 *   2. DialBridged → someone talked to the customer: clear transfer_state, hang up. (Bridged,
 *      not DialCallStatus: a screened cell that hangs up without pressing 1 also reads
 *      `completed`);
 *   3. within 60 minutes of a 911 call from this number → never voicemail: ring that person again;
 *   4. anything else → clear transfer_state, then the next member (in_order), or the forward
 *      (screened) if the route says so, or the greeting and voicemail. A forward nobody takes
 *      ends in voicemail.
 */
export async function afterDial(env: Env, ec: Ctx, p: TwilioParams, url: URL): Promise<string> {
  const admin = adminClient(env);
  const callId = url.searchParams.get("call") ?? "";
  const transfer = url.searchParams.get("transfer") === "1";
  const stage = url.searchParams.get("stage") ?? "";
  if (!UUID_RE.test(callId)) {
    ec.waitUntil(logFault({ code: "after_dial_no_call", message: "after-dial reached without a call id." }));
    return response(hangup());
  }

  if (stage === "out") {
    const out = await withCallRow(admin, callId, 3);
    // A device switch (../handoff.ts) has given the call to the person's other device: this is
    // the leg it moved FROM, and it no longer holds the call. Before that hand-over it joins the
    // conference as below, so if the switch fails it still has the call.
    const leg = String(p.CallSid ?? "");
    if (out && leg && leg === out.handoff_from_sid && leg !== out.client_call_sid) return response(hangup());
    if (out?.transfer_state === "conference" && !out.ended_at) return conferenceTwiml(env, out.id, "agent");
    return response(hangup());
  }

  // Which number this call belongs to, from the leg's own params, read in parallel with the row.
  // (Inbound parent: To is the builder number. A transferred outbound customer leg is an
  // outbound-dial whose From is the builder number, our caller ID.)
  const guessNumber = String(p.Direction ?? "").startsWith("outbound") ? String(p.From ?? "") : String(p.To ?? "");
  // withCallRow: a Dial to identities with no device online can end within milliseconds, before
  // the background insert from /voice/inbound has landed. A short retry covers that race.
  const [call, guessed] = await Promise.all([
    withCallRow(admin, callId, 3),
    guessNumber ? routeForNumber(admin, guessNumber) : Promise.resolve(null),
  ]);
  if (!call) {
    ec.waitUntil(logFault({ code: "after_dial_unknown_call", message: `after-dial for a call with no row (${callId}).` }));
    return voicemailTwiml(env, callId, guessed);
  }

  // 0. (before any further lookup: the customer is waiting on this answer, and needs no route)
  if (call.transfer_state === "conference") return conferenceTwiml(env, call.id, "customer");

  let info = guessed;
  if (!info || (call.number_id && info.number_id !== call.number_id)) {
    info = await routeForNumber(admin, call.direction === "in" ? call.to_e164 : call.from_e164);
  }

  // 1.
  if (!transfer && call.transfer_state) return response();

  const bridged = p.DialBridged !== undefined ? p.DialBridged === "true" : p.DialCallStatus === "completed";
  const clearTransfer = () => {
    if (call.transfer_state) ec.waitUntil(patchCall(admin, callId, { transfer_state: null }));
  };

  // 2.
  if (bridged) {
    clearTransfer();
    return response(hangup());
  }

  // 3.
  if (info?.recent_emergency_user) {
    const round = stage === "er" ? Math.max(1, intVar(url.searchParams.get("n") ?? "", 1, 1)) + 1 : 1;
    const target = await emergencyTarget(admin, info);
    if (target && round <= EMERGENCY_ROUNDS) {
      if (!call.rang_user_ids.includes(target.user_id)) {
        ec.waitUntil(patchCall(admin, callId, { rang_user_ids: [...call.rang_user_ids, target.user_id] }));
      }
      return emergencyDial(env, callId, info, target, round);
    }
    if (target) return response(say("We could not reach anyone. Please call back."), hangup());
  }

  // 4.
  clearTransfer();
  if (!info) return voicemailTwiml(env, callId, null);

  if (stage === "order" && !transfer) {
    const after = intVar(url.searchParams.get("p") ?? "", -1, -1);
    const next = ringPlan(info, Date.now(), after);
    if (next) {
      const ids = next.members.map((m) => m.user_id).filter((id) => !call.rang_user_ids.includes(id));
      if (ids.length) ec.waitUntil(patchCall(admin, callId, { rang_user_ids: [...call.rang_user_ids, ...ids] }));
      return ringTwiml(env, callId, info, next);
    }
  }

  if (stage !== "fwd" && info.route.no_answer === "forward") {
    const fwd = toE164(info.route.forward_to);
    if (fwd) return forwardTwiml(env, callId, info, fwd);
  }
  return voicemailTwiml(env, callId, info);
}

// ── /voice/screen ────────────────────────────────────────────────────────────────────

/**
 * The press-1 screen on a forwarded cell. A cell that is off or declines rolls to the carrier's
 * voicemail, which Twilio counts as answered; without this, the customer's message would land in
 * an employee's personal voicemail. Pressing 1 returns an empty document, which bridges the call.
 * Anything else hangs the cell leg up, and the forward Dial's action takes the customer to the
 * builder's own voicemail.
 */
export async function screen(env: Env, ec: Ctx, p: TwilioParams, url: URL): Promise<string> {
  const callId = url.searchParams.get("call") ?? "";
  const business = (url.searchParams.get("b") ?? "").slice(0, 60);
  const userId = url.searchParams.get("user") ?? "";
  if (url.searchParams.get("step") !== "accept") {
    return response(
      gather({
        action: hook(env, "/voice/screen", { call: callId, user: userId || undefined, b: business, step: "accept" }),
        numDigits: 1,
        timeout: 8,
      }, [say(`My Synergy Phone call for ${business || "your business"}, press 1 to answer.`)]),
      hangup(),
    );
  }
  if (String(p.Digits ?? "") !== "1") return response(hangup());

  if (UUID_RE.test(callId)) {
    const admin = adminClient(env);
    ec.waitUntil((async () => {
      const at = nowIso();
      // The accepted cell is "the leg that answered for us": client_call_sid holds it so the
      // leg's completion can be told apart from the legs that only rang.
      await patchCall(admin, callId, {
        status: "in_progress", answered_at: at, client_call_sid: p.CallSid ?? null,
        answered_by: UUID_RE.test(userId) ? userId : null,
      }, (q) => q.in("status", ["ringing"]));
      await addCallEvent(admin, callId, "answered", { leg: "cell", user: UUID_RE.test(userId) ? userId : null }, at);
    })());
  }
  return response();
}

// ── /voice/status ────────────────────────────────────────────────────────────────────

const TERMINAL = new Set(["completed", "busy", "no-answer", "failed", "canceled"]);

function eventName(status: string): string {
  if (status === "in-progress" || status === "answered") return "answered";
  if (TERMINAL.has(status)) return "ended";
  return status || "status";
}

function unansweredOutcome(status: string): string {
  if (status === "busy") return "busy";
  if (status === "failed") return "failed";
  return "no_answer"; // no-answer, and canceled (the builder hung up before they picked up)
}

/**
 * Writes phone_calls from Twilio's progress callbacks. Runs in waitUntil after the 204.
 *
 *   leg=pstn & call  the customer's leg of an OUTBOUND call (the <Number>)
 *   leg=client & call  a <Client> an inbound call (or a transfer) rang
 *   leg=cell & call  a forwarded cell; its answer is marked by /voice/screen on press 1
 *   leg=warm & call  the teammate a warm transfer dialed into the conference (conference.ts)
 *   leg=handoff & call  the ring a device switch placed to the person's phone (handoff.ts)
 *   leg=pstn, no call  the number's own status callback: the inbound customer leg
 *   leg=client, no call  the TwiML App's status callback: the outbound app leg
 *
 * `signed` is false when the request was accepted on ?key= alone (DEVIATIONS 30).
 */
export async function applyStatus(env: Env, p: TwilioParams, url: URL, signed = true): Promise<void> {
  const admin = adminClient(env);
  const callId = url.searchParams.get("call") ?? "";
  const leg = url.searchParams.get("leg") ?? "";
  const status = String(p.CallStatus ?? "");
  const sid = String(p.CallSid ?? "");
  const at = twilioTime(p);
  const duration = Number.parseInt(String(p.CallDuration ?? ""), 10);

  let row: CallRow | null = null;
  if (UUID_RE.test(callId)) {
    row = await withCallRow(admin, callId);
  } else if (sid) {
    const col = leg === "client" ? "client_call_sid" : "twilio_call_sid";
    // The row is inserted in waitUntil after the TwiML, so a leg's FINAL callback can beat it:
    // an inbound caller who hangs up at once, or while a cold isolate is still answering.
    // Dropped, that call would stay 'ringing' for good. Ending is the one event worth the
    // short wait withCallRow gives callbacks that carry a call id; the others are not.
    const tries = TERMINAL.has(status) ? 4 : 1;
    for (let i = 0; i < tries && !row; i++) {
      if (i) await new Promise((r) => setTimeout(r, 150 * 2 ** (i - 1)));
      const { data } = await admin.from("phone_calls").select("id").eq(col, sid).maybeSingle();
      const id = (data as { id?: string } | null)?.id;
      row = id ? await callById(admin, id) : null;
    }
  }
  if (!row) return; // a leg we never recorded (a refused call, or another product's call)
  const id = row.id;

  const who = leg === "client" ? parseIdentity(stripClientPrefix(String(p.To ?? "")))?.userId ?? null : null;
  await addCallEvent(admin, id, eventName(status), {
    leg: leg || null, status, sid: sid || null, user: who ?? (url.searchParams.get("user") || null),
    duration: Number.isFinite(duration) ? duration : null,
  }, at);

  // The call itself ending (its holder's leg, or the customer's) while a move to the person's
  // other device is still ringing: stop the ring. Nothing below changes for it.
  if (row.handoff_state === "ringing") {
    await endRingWithCall(env, row, sid, status, signed).catch((e) => logFault({
      code: "handoff_cancel_failed", clientId: row!.client_id, message: (e as Error).message, context: { callId: id },
    }));
  }

  const finalDuration = (): number | null => {
    if (row!.transferred_from && row!.answered_at) {
      const s = Math.round((Date.parse(at) - Date.parse(row!.answered_at)) / 1000);
      return Number.isFinite(s) && s >= 0 ? s : null;
    }
    return Number.isFinite(duration) ? duration : null;
  };

  if (UUID_RE.test(callId) && leg === "pstn") {
    // Outbound customer leg.
    if (!row.twilio_call_sid && sid) await patchCall(admin, id, { twilio_call_sid: sid }, (q) => q.is("twilio_call_sid", null));
    if (status === "in-progress" || status === "answered") {
      // The callbacks are separate requests handled in separate background tasks, so on a
      // short call 'completed' can be written first (its filter takes a 'ringing' row). A late
      // answer must not reopen an ended call: that left it 'in_progress' for good, never queued
      // for billing, shown as live, and its placer busy to inbound calls for four hours.
      const opened = await patchCall(admin, id, { status: "in_progress", answered_at: at }, (q) => q.is("answered_at", null).is("ended_at", null));
      if (!opened) await patchCall(admin, id, { answered_at: at }, (q) => q.is("answered_at", null));
    } else if (status === "completed") {
      await patchCall(admin, id, { status: "completed", ended_at: at, duration_s: finalDuration() }, (q) => q.in("status", ["ringing", "in_progress", "no_answer"]));
    } else if (TERMINAL.has(status)) {
      await patchCall(admin, id, { status: unansweredOutcome(status), ended_at: at }, (q) => q.is("answered_at", null).in("status", ["ringing", "no_answer"]));
    }
    // The customer is gone, so no transfer or conference can still be under way.
    if (TERMINAL.has(status) && row.transfer_state) await patchCall(admin, id, { transfer_state: null });
    return;
  }

  // In the conference, whoever holds the call for us may hang up while the customer stays
  // (with a teammate, or on the way to voicemail). The CUSTOMER's leg ending closes the row.
  const inConference = row.transfer_state === "conference";

  if (inConference && !row.ended_at && TERMINAL.has(status) && sid && sid === row.client_call_sid) {
    // The leg holding the call for us has ended (any of leg=client, cell, warm, or the
    // outbound app leg): a customer it left alone must not wait on hold music for good, even
    // if the conference's own leave event was skipped or failed (conference.ts holderLegEnded).
    try {
      await holderLegEnded(env, row, sid, signed);
    } catch (e) {
      await logFault({ code: "conference_backstop_failed", clientId: row.client_id, message: (e as Error).message, context: { callId: id } });
    }
    return;
  }

  if (UUID_RE.test(callId) && leg === "warm") {
    // The teammate a warm transfer dialed into the conference (conference.ts).
    await warmLegStatus(env, row, p, url, signed);
    return;
  }

  if (UUID_RE.test(callId) && leg === "handoff") {
    // The ring a device switch placed to the person's own phone (../handoff.ts). Once it holds
    // the call it is client_call_sid, and its end is the holder's, above.
    await handoffLegStatus(env, row, p, signed);
    return;
  }

  if (UUID_RE.test(callId) && leg === "client") {
    if ((status === "in-progress" || status === "answered") && who) {
      // First answer wins; a transfer clears answered_by so the teammate's answer lands. The
      // teammate answering also ends the transfer (plan 9C), which is what lets them transfer
      // the call on again.
      await patchCall(admin, id, {
        status: "in_progress", answered_by: who, client_call_sid: sid || null,
        ...(row.answered_at ? {} : { answered_at: at }),
        ...(row.transfer_state ? { transfer_state: null } : {}),
      }, (q) => q.is("answered_by", null));
    } else if (status === "completed" && sid && sid === row.client_call_sid && !inConference) {
      await patchCall(admin, id, { status: "completed", ended_at: at, duration_s: finalDuration() }, (q) => q.in("status", ["ringing", "in_progress"]));
    }
    return;
  }

  if (UUID_RE.test(callId) && leg === "cell") {
    if (status === "completed" && sid && sid === row.client_call_sid && !inConference) {
      await patchCall(admin, id, { status: "completed", ended_at: at, duration_s: finalDuration() }, (q) => q.in("status", ["ringing", "in_progress"]));
    }
    return;
  }

  // Parent legs (no call id): only their end matters.
  if (!TERMINAL.has(status)) return;
  if (leg === "pstn" && row.direction === "in") {
    // Nobody picked up and no message was left: a missed call. A voicemail keeps its status.
    // A call still marked in progress is over now that the customer's leg is (this is how a
    // transfer that ended in voicemail, whose answering leg was handed on, gets closed).
    if (row.status === "ringing") {
      await patchCall(admin, id, { status: "missed", ended_at: at }, (q) => q.eq("status", "ringing"));
    } else if (row.status === "in_progress") {
      const talk = row.answered_at ? Math.round((Date.parse(at) - Date.parse(row.answered_at)) / 1000) : NaN;
      await patchCall(admin, id, {
        status: "completed", ended_at: at,
        ...(row.duration_s == null && Number.isFinite(talk) && talk >= 0 ? { duration_s: talk } : {}),
      }, (q) => q.eq("status", "in_progress"));
    }
    await patchCall(admin, id, { ended_at: at }, (q) => q.is("ended_at", null));
    // The customer is gone, so no transfer can still be under way.
    if (row.transfer_state) await patchCall(admin, id, { transfer_state: null });
    return;
  }
  if (leg === "client" && row.direction === "out") {
    await patchCall(admin, id, { status: "no_answer", ended_at: at }, (q) => q.eq("status", "ringing"));
    await patchCall(admin, id, { ended_at: at }, (q) => q.is("ended_at", null).is("transfer_state", null));
  }
}

// ── /voice/voicemail ─────────────────────────────────────────────────────────────────

/** File one recording against its call (the Record action, its status callback, or the sweep). */
export async function fileVoicemail(admin: Admin, callId: string, recordingSid: string, durationS: number): Promise<boolean> {
  if (!recordingSid || !(durationS >= MIN_VOICEMAIL_SECONDS)) return false;
  const call = await withCallRow(admin, callId);
  if (!call) {
    await logFault({ code: "voicemail_no_call", message: `A voicemail arrived for a call with no row (${callId}); the sweep will retry.` });
    return false;
  }
  const { error } = await admin.from("phone_voicemails").upsert({
    call_id: call.id, client_id: call.client_id, recording_sid: recordingSid, duration_s: Math.round(durationS),
  }, { onConflict: "call_id" });
  if (error) {
    await logFault({ code: "voicemail_insert_failed", message: `phone_voicemails upsert failed: ${error.message}`, clientId: call.client_id, context: { callId } });
    return false;
  }
  // An answered call that ended in voicemail (a transfer nobody took) stays answered.
  await patchCall(admin, call.id, { status: "voicemail" }, (q) => q.is("answered_by", null).in("status", ["ringing", "missed"]));
  // Reaching voicemail ends a transfer (plan 9C), including the DND path, which has no Dial.
  if (call.transfer_state) await patchCall(admin, call.id, { transfer_state: null });
  await addCallEvent(admin, call.id, "voicemail", { duration: Math.round(durationS) });
  return true;
}

export function voicemail(env: Env, ec: Ctx, p: TwilioParams, url: URL): { xml: string | null } {
  const callId = url.searchParams.get("call") ?? "";
  const isStatus = url.searchParams.get("cb") === "status" || p.RecordingStatus !== undefined;
  const recordingSid = String(p.RecordingSid ?? "");
  const duration = Number.parseInt(String(p.RecordingDuration ?? ""), 10);
  const usable = UUID_RE.test(callId) && recordingSid && (!isStatus || p.RecordingStatus === "completed");
  if (usable) ec.waitUntil(fileVoicemail(adminClient(env), callId, recordingSid, duration));
  return { xml: isStatus ? null : response(hangup()) };
}

// ── /voice/transcription ─────────────────────────────────────────────────────────────

/** Longer than any 2-minute message Twilio will transcribe; a cap, not a limit anyone meets. */
const MAX_TRANSCRIPT = 8000;

/**
 * Store a finished transcript on the call's voicemail. The Record action files the voicemail
 * within seconds and a transcript takes longer, so the row is nearly always there; a short
 * retry covers the rest, and if it is still missing the row is created WITH the transcript
 * (fileVoicemail's later upsert on call_id leaves the transcript alone).
 */
export async function fileTranscript(admin: Admin, callId: string, recordingSid: string, text: string, tries = 3): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    const { data, error } = await admin.from("phone_voicemails").update({ transcript: text }).eq("call_id", callId).select("id");
    if (error) {
      await logFault({ code: "transcript_write_failed", message: `phone_voicemails transcript update failed: ${error.message}`, context: { callId } });
      return false;
    }
    if (Array.isArray(data) && data.length) {
      await addCallEvent(admin, callId, "transcribed", { chars: text.length });
      return true;
    }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, 300 * 2 ** i));
  }
  const call = await callById(admin, callId);
  if (!call) {
    await logFault({ code: "transcript_no_call", message: `A transcript arrived for a call with no row (${callId}).` });
    return false;
  }
  const { error } = await admin.from("phone_voicemails").upsert({
    call_id: call.id, client_id: call.client_id, recording_sid: recordingSid || null, transcript: text,
  }, { onConflict: "call_id" });
  if (error) {
    await logFault({ code: "transcript_write_failed", clientId: call.client_id, message: `phone_voicemails transcript upsert failed: ${error.message}`, context: { callId } });
    return false;
  }
  await addCallEvent(admin, call.id, "transcribed", { chars: text.length });
  return true;
}

/** Twilio's transcribeCallback (TRANSCRIBE=on). Runs in waitUntil after the 204. */
export async function transcription(env: Env, p: TwilioParams, url: URL): Promise<void> {
  const callId = url.searchParams.get("call") ?? "";
  if (!UUID_RE.test(callId)) return;
  const admin = adminClient(env);
  const text = String(p.TranscriptionText ?? "").trim().slice(0, MAX_TRANSCRIPT);
  if (p.TranscriptionStatus !== "completed" || !text) {
    // Too long, too short, silence or not English: the message is still there to play.
    await addCallEvent(admin, callId, "transcription_failed", { status: String(p.TranscriptionStatus ?? "") || null });
    return;
  }
  await fileTranscript(admin, callId, String(p.RecordingSid ?? ""), text);
}
