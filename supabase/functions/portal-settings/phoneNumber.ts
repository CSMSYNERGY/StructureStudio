// My Synergy Phone, plan phase 6 (section 16, row 6): a builder's number for CALLS, self-serve.
//
//   * A CALLING-ONLY NUMBER for a builder who has no texting number yet (plan D6: "Voice needs
//     no A2P registration, so phase 6 adds a way to buy a number for calls straight away;
//     texting reuses the same number once registration clears"). Bought through Twilio with
//     portal-sms's own purchase helper (_shared/twilioTrustHub.ts purchaseNumber), recorded as
//     an ordinary sms_numbers row that is NOT registered for texting and is attached to NO
//     messaging service. The texting setup adopts a builder's first number rather than buy a
//     second. Since migration 266 a builder may have up to ten (per-person numbers, Carolyn
//     09-30): a later one joins the builder's texting setup straight away when texting is already
//     on (attachToTexting below), and stays calling-only otherwise.
//   * CONNECTING A NUMBER FOR CALLS: point its voice webhooks at the phone-api Worker, which is
//     what "voice_enabled" on sms_numbers records.
//
// This file is the part that can be tested without a network: the environment it needs, the
// exact webhook settings, and the two Twilio REST calls with an injectable fetch. The handlers
// in index.ts do the reads, the writes and the refusals.
//
// The credentials both REST calls take are the TENANT'S account (Workstream 2): index.ts resolves
// them once per request through _shared/twilioAccount.ts (the parent from the environment while
// TWILIO_SUBACCOUNTS is not "on", which is what this file's own copy, twilioCreds, read until
// phase 2 moved it there as parentCreds).
import type { TwilioCreds } from "../_shared/twilioAccount.ts";
export type { TwilioCreds };

/** The Worker's public base when PHONE_API_BASE is not set (SPEC section 1). The portal's
 *  SS_PHONE_API_BASE in 01-core.jsx defaults to the same address. */
export const DEFAULT_PHONE_API_BASE = "https://phone.structurestudiosuite.com";

const TWILIO_API = "https://api.twilio.com/2010-04-01";

type EnvGet = (name: string) => string | undefined | null;

export type VoiceEnv = { apiBase: string; secret: string; fallbackUrl: string };

/**
 * What connecting a number for calls needs from the edge environment:
 *   PHONE_API_BASE        the Worker's public base (default DEFAULT_PHONE_API_BASE), https only
 *   PHONE_WEBHOOK_SECRET  the ?key= every Worker voice URL carries; the Worker refuses without it
 *   PHONE_FALLBACK_URL    the number's Voice Fallback URL: the TwiML Bin that still takes a
 *                         message when the Worker is down (phase 1b's "pointing the voice URL
 *                         at a dead address still gets the caller to voicemail"). REQUIRED:
 *                         connecting a number with no fallback would make a Worker outage dead
 *                         air for the builder's customers, so it is refused instead.
 * Missing or malformed values are named (never their contents) so the refusal can say which.
 */
export function voiceEnv(get: EnvGet): { ok: true; env: VoiceEnv } | { ok: false; missing: string[] } {
  const missing: string[] = [];
  const base = String(get("PHONE_API_BASE") ?? "").trim().replace(/\/+$/, "") || DEFAULT_PHONE_API_BASE;
  if (!/^https:\/\/[^/?#\s]+(\/[^?#\s]*)?$/.test(base)) missing.push("PHONE_API_BASE");
  const secret = String(get("PHONE_WEBHOOK_SECRET") ?? "").trim();
  if (!secret) missing.push("PHONE_WEBHOOK_SECRET");
  const fallbackUrl = fallbackUrlOf(get);
  if (!fallbackUrl) missing.push("PHONE_FALLBACK_URL");
  if (missing.length || !fallbackUrl) return { ok: false, missing };
  return { ok: true, env: { apiBase: base, secret, fallbackUrl } };
}

/** PHONE_FALLBACK_URL, https only, or null. Moving a number to voicemail needs this alone. */
export function fallbackUrlOf(get: EnvGet): string | null {
  const fallbackUrl = String(get("PHONE_FALLBACK_URL") ?? "").trim();
  return /^https:\/\/\S+$/.test(fallbackUrl) ? fallbackUrl : null;
}

/**
 * The Worker's percent-encoding (workers/phone-api/src/urls.ts strictEncode), copied rather
 * than imported because the Worker is a separate deploy. Twilio signs the URL exactly as it was
 * written here, and the Worker checks X-Twilio-Signature against the URL it receives, so both
 * sides must agree byte for byte.
 */
export function strictEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * The number's voice settings, exactly as the Worker's SETUP.md (section 2, step 6) configures
 * the pilot number by hand, and in the Worker's own parameter order (`hook()` puts key last):
 *   A call comes in       POST <base>/voice/inbound?key=<secret>
 *   Call status changes   POST <base>/voice/status?leg=pstn&key=<secret>
 *   Primary handler fails POST <PHONE_FALLBACK_URL>
 * The messaging settings are not touched: texts stay on sms-inbound and sms-status.
 */
export function numberVoiceConfig(env: VoiceEnv): Record<string, string> {
  const key = strictEncode(env.secret);
  return {
    VoiceUrl: `${env.apiBase}/voice/inbound?key=${key}`,
    VoiceMethod: "POST",
    StatusCallback: `${env.apiBase}/voice/status?leg=pstn&key=${key}`,
    StatusCallbackMethod: "POST",
    VoiceFallbackUrl: env.fallbackUrl,
    VoiceFallbackMethod: "POST",
  };
}

/**
 * The number's voice settings while calling is OFF for its tenant (and for a calling-only number
 * bought before calling is on): straight to the voicemail Bin, the same PHONE_FALLBACK_URL that
 * catches calls while the Worker is down. The Bin plays the greeting and records, and the Worker's
 * every-15-minutes recording sweep (workers/phone-api/src/cron/sweep.ts) files each message as a
 * phone_calls row plus its voicemail, routed by the number that was called — whatever the
 * tenant's switch says.
 *
 * ⚠️ WHY THE SWITCH HAS TO MOVE THE NUMBER (review SSB-2). The Worker answers a tenant that is
 * off with "Sorry, this number can't take calls right now" and hangs up BEFORE any row is
 * written (routes/voice.ts). Leaving a connected number pointed at the Worker while the switch
 * is off therefore dropped every customer call with no voicemail and no trace.
 *
 * The status callback and the fallback are CLEARED (Twilio clears a URL given as ""), so the
 * Worker is not sent status events for calls it never saw. The messaging settings are not
 * touched.
 */
export function numberVoicemailConfig(env: Pick<VoiceEnv, "fallbackUrl">): Record<string, string> {
  return {
    VoiceUrl: env.fallbackUrl,
    VoiceMethod: "POST",
    StatusCallback: "",
    VoiceFallbackUrl: "",
  };
}

/**
 * Where a CALLING-ONLY number's texts go (review SSB-3): sms-inbound, with its shared secret,
 * written exactly the way portal-sms writes it onto a texting Messaging Service
 * (`${SUPABASE_URL}/functions/v1/sms-inbound?key=${SMS_INBOUND_SECRET}`, the secret raw) —
 * sms-inbound rebuilds that same URL to check X-Twilio-Signature, so the two must agree byte
 * for byte. sms-inbound resolves the tenant from the To number alone (the sms_numbers row), so a
 * customer who texts back the number a builder called them from lands in sms_messages under
 * the right tenant straight away.
 *
 * A calling-only number is attached to NO messaging service, so Twilio uses the number's own
 * SmsUrl; with it empty, every reply was dropped at Twilio and never reached Structure Studio.
 * ONLY for calling-only numbers: a number inside a Messaging Service takes its inbound route from
 * the service, and writing SmsUrl onto it would change nothing today and could change behaviour
 * the day the service is set to defer to the sender. null = not configured on this server.
 */
export function smsInboundUrl(get: EnvGet): string | null {
  const base = String(get("SUPABASE_URL") ?? "").trim().replace(/\/+$/, "");
  const secret = String(get("SMS_INBOUND_SECRET") ?? "");
  if (!/^https:\/\/[^/?#\s]+/.test(base) || !secret.trim()) return null;
  return `${base}/functions/v1/sms-inbound?key=${secret}`;
}

export function numberSmsConfig(inboundUrl: string): Record<string, string> {
  return { SmsUrl: inboundUrl, SmsMethod: "POST" };
}

/**
 * What the calling switch does to the tenant's number (review SSB-2):
 *   off, and the number points at the Worker      → "to_voicemail" (numberVoicemailConfig)
 *   on, the number was connected before and the
 *   switch moved it to voicemail                   → "connect" (numberVoiceConfig)
 *   anything else                                  → null (nothing to change)
 * voice_configured_at is only ever written by a successful connect, so it is what "was
 * connected before" means; a number that was never connected waits for the owner's Connect.
 */
export function numberActionForSwitch(
  on: boolean,
  n: { voice_enabled?: boolean | null; voice_configured_at?: string | null } | null,
): "to_voicemail" | "connect" | null {
  if (!n) return null;
  if (!on) return n.voice_enabled === true ? "to_voicemail" : null;
  return n.voice_enabled !== true && !!n.voice_configured_at ? "connect" : null;
}

export type TwilioFail = { ok: false; status: number; code: number };
type Fetch = typeof fetch;

async function twilio(creds: TwilioCreds, method: "GET" | "POST", path: string, form: Record<string, string> | null, f: Fetch):
  Promise<{ ok: true; body: Record<string, unknown> } | TwilioFail> {
  let res: Response;
  try {
    res = await f(`${TWILIO_API}/Accounts/${encodeURIComponent(creds.accountSid)}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${btoa(`${creds.user}:${creds.pass}`)}`,
        ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
  } catch {
    return { ok: false, status: 0, code: 0 };
  }
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try { body = text ? JSON.parse(text) : {}; } catch { /* an HTML error page */ }
  // ⚠️ Codes only. Twilio's error bodies echo what was sent, and what was sent here includes
  // the webhook secret inside VoiceUrl, so the body never leaves this function.
  if (!res.ok) return { ok: false, status: res.status, code: typeof body.code === "number" ? body.code : 0 };
  return { ok: true, body };
}

/** Point one number's voice webhooks at the Worker. Idempotent: the same POST twice is the
 *  same configuration. */
export async function applyNumberVoice(opts: {
  creds: TwilioCreds; numberSid: string; config: Record<string, string>; fetchImpl?: Fetch;
}): Promise<{ ok: true } | TwilioFail> {
  if (!/^PN[0-9a-f]{32}$/i.test(opts.numberSid)) return { ok: false, status: 400, code: 0 };
  const r = await twilio(opts.creds, "POST", `/IncomingPhoneNumbers/${opts.numberSid}.json`, opts.config, opts.fetchImpl ?? fetch);
  return r.ok ? { ok: true } : r;
}

/** A number's PN… sid by its E.164, for a row recorded without one (a number bought by hand
 *  in the console, like the pilot's). null = this account has no such number. */
export async function findNumberSid(opts: { creds: TwilioCreds; e164: string; fetchImpl?: Fetch }):
  Promise<{ ok: true; sid: string | null } | TwilioFail> {
  const r = await twilio(opts.creds, "GET", `/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(opts.e164)}&PageSize=5`, null, opts.fetchImpl ?? fetch);
  if (!r.ok) return r;
  const list = Array.isArray(r.body.incoming_phone_numbers) ? r.body.incoming_phone_numbers as Record<string, unknown>[] : [];
  const hit = list.find((n) => String(n.phone_number ?? "") === opts.e164);
  return { ok: true, sid: hit ? String(hit.sid ?? "") || null : null };
}

/** The US number a builder picked from the search results, or null. Search only ever offers
 *  +1 numbers (searchAvailableNumbers reads AvailablePhoneNumbers/US), so nothing else is bought. */
export function pickedNumber(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  return /^\+1[2-9]\d{2}[2-9]\d{6}$/.test(s) ? s : null;
}

/** Search input: a three-digit area code, or nothing. */
export function areaCodeOf(raw: unknown): string | null {
  const d = String(raw ?? "").replace(/\D/g, "");
  return /^[2-9]\d{2}$/.test(d) ? d : null;
}

// ── The calling-only purchase ────────────────────────────────────────────────────────────

export type Bought = { sid: string; phoneNumber: string };

/**
 * RECONCILE BEFORE BUYING. A previous press may have bought a number with its response lost in
 * flight, or bought it and then failed to record it (purchaseNumber sets FriendlyName =
 * client_id for exactly this), and buying again would rent a second number nobody knows about.
 *
 * ⚠️ ANY UNRECORDED NUMBER IS ADOPTED, NOT ONLY THE ONE PICKED THIS TIME (review SSB-4). A
 * number that was bought is gone from Twilio's search results, so the builder can only pick a
 * DIFFERENT one on the next press; matching on the pick alone bought that one too and left the
 * first rented forever. Every FriendlyName=client_id number Twilio lists that is NOT one of the
 * tenant's live sms_numbers rows (`recorded`) is one we pay for and have not recorded: the
 * builder's own pick wins if it is among them, otherwise the first of them is kept and the new
 * pick is ignored.
 *
 * ⚠️ `recorded` MATTERS SINCE A TENANT CAN HOLD MORE THAN ONE NUMBER (migration 266). Before, the
 * caller refused any tenant with a live number, so everything Twilio listed was unrecorded. Now
 * the tenant's own recorded numbers carry the same FriendlyName, and "adopting" one of them would
 * record it twice (sms_numbers_live_unique refuses) and never buy the second number at all.
 *
 * Of those numbers, this returns the one to adopt, or null (none: buy the pick).
 */
export function pickOrphan(already: Bought[], wanted: string, recorded: string[] = []): Bought | null {
  const ours = new Set((recorded ?? []).map(String));
  const real = (already ?? []).filter((n) => n && n.sid && n.phoneNumber && !ours.has(n.phoneNumber));
  return real.find((n) => n.phoneNumber === wanted) ?? real[0] ?? null;
}

/** portal-sms buy_number's wallet key for a number, character for character, so buying the same
 *  number through either tab (or retrying either) is ONE hold, never two. */
export function numberHoldKey(clientId: string, e164: string): string {
  return `sms_num:${clientId}:${e164}`.slice(0, 120);
}

export type HoldResult =
  | { ok: true; holdId: number | null }
  | { ok: false; status: number; body: Record<string, unknown> };

export type NumberRow = { id: string; phone_number: string; twilio_sid: string | null };

export type BuyOutcome =
  | { ok: true; row: NumberRow; bought: Bought; reconciled: boolean; adoptedInstead: boolean }
  | { ok: false; kind: "refused"; status: number; body: Record<string, unknown> }
  | { ok: false; kind: "lookup_failed"; error: unknown }
  | { ok: false; kind: "purchase_failed"; error: unknown }
  | { ok: false; kind: "record_failed"; error: unknown; bought: Bought; releasedAtTwilio: boolean };

/**
 * The whole calling-only purchase, in the order money and numbers have to move (portal-sms
 * buy_number's order, plus the two failure paths review SSB-4 found open):
 *
 *   ⚠️ NO messagingServiceSid, ever. purchaseNumber attaches a number to a messaging service
 *   only when it is given one, and a calling-only number must not be attached until the
 *   builder's texting registration clears; texting adopts this number then. Its texts reach
 *   sms-inbound through the number's own SmsUrl instead (numberSmsConfig), which the handler
 *   sets right after this returns.
 *
 *   1. Adopt any unrecorded number first (pickOrphan; `recorded` = the tenant's live numbers, which
 *      are never "unrecorded").
 *   2. Take the wallet hold on sms_number_monthly under numberHoldKey(THE NUMBER KEPT), portal-sms's
 *      meter and key: the number bills monthly at Twilio from the moment it is bought, so the
 *      first month is held here exactly as the texting purchase holds it. An adopted number was
 *      held under its own key by the press that bought it, so re-holding answers
 *      `hold_replayed` (already paid; the caller maps that to holdId null) instead of charging
 *      twice. A refused hold (no funds, meter down) buys nothing. Months 2 and on are the
 *      phone-api Worker's daily cron (workers/phone-api/src/cron/numberFee.ts), on this meter
 *      under its own per-month key, so the first month is never charged twice.
 *   3. Buy, unless adopting. A failed purchase releases the hold.
 *   4. Record the sms_numbers row. If THAT fails after a FRESH purchase, the number is released
 *      at Twilio and the hold released, so nothing stays rented that nobody recorded. An adopted
 *      number is never released here (it may be the only copy of an earlier purchase; the next
 *      press adopts it again), and its fresh hold, if any, is released.
 *   5. Capture the hold.
 */
export async function buyCallingNumber(
  opts: { clientId: string; wanted: string; recorded?: string[] },
  deps: {
    findPurchasedNumbers: (clientId: string) => Promise<Bought[]>;
    purchaseNumber: (o: { phoneNumber: string; clientId: string }) => Promise<Bought>;
    releaseNumber: (sid: string) => Promise<void>;
    hold: (idem: string) => Promise<HoldResult>;
    capture: (holdId: number, bought: Bought) => Promise<void>;
    releaseHold: (holdId: number, reason: string) => Promise<void>;
    record: (bought: Bought) => Promise<{ ok: true; row: NumberRow } | { ok: false; error: unknown }>;
  },
): Promise<BuyOutcome> {
  let already: Bought[];
  try {
    already = await deps.findPurchasedNumbers(opts.clientId);
  } catch (e) {
    return { ok: false, kind: "lookup_failed", error: e };
  }
  const orphan = pickOrphan(already, opts.wanted, opts.recorded ?? []);
  const target = orphan ? orphan.phoneNumber : opts.wanted;

  const held = await deps.hold(numberHoldKey(opts.clientId, target));
  if (!held.ok) return { ok: false, kind: "refused", status: held.status, body: held.body };
  const holdId = held.holdId;
  const letGo = async (reason: string) => {
    if (holdId) await deps.releaseHold(holdId, reason).catch(() => {});
  };

  let bought: Bought;
  if (orphan) {
    bought = orphan;
  } else {
    try {
      bought = await deps.purchaseNumber({ phoneNumber: target, clientId: opts.clientId });
    } catch (e) {
      await letGo("number purchase failed");
      return { ok: false, kind: "purchase_failed", error: e };
    }
  }

  const rec = await deps.record(bought);
  if (!rec.ok) {
    let releasedAtTwilio = false;
    if (!orphan && bought.sid) {
      try { await deps.releaseNumber(bought.sid); releasedAtTwilio = true; } catch { /* reported below */ }
    }
    await letGo("number bought but not recorded");
    return { ok: false, kind: "record_failed", error: rec.error, bought, releasedAtTwilio };
  }
  if (holdId) await deps.capture(holdId, bought).catch(() => {});
  return { ok: true, row: rec.row, bought, reconciled: !!orphan, adoptedInstead: !!orphan && orphan.phoneNumber !== opts.wanted };
}

/**
 * The sms_numbers row a calling-only number is recorded as. registration_status is 165's
 * 'pending_registration', the only word its vocabulary (pending_registration | registered |
 * failed, Twilio's externalstatus) has for "not registered for texting"; sendTenantSms refuses
 * to text from anything that is not 'registered', so the row cannot send a text by accident.
 * messaging_service_sid NULL is what marks it calling-only. voice_enabled stays at its default
 * (false) until the number is connected for calls.
 */
export function callingOnlyNumberRow(clientId: string, bought: Bought, subAccountSid: string | null = null) {
  return {
    client_id: clientId,
    phone_number: bought.phoneNumber,
    twilio_sid: bought.sid || null,
    messaging_service_sid: null,
    registration_status: "pending_registration",
    // Workstream 2 (migration 292): a number bought inside the tenant's own sub-account says so.
    // Absent (the parent, NULL) the row is exactly what it was before sub-accounts.
    ...(subAccountSid ? { twilio_account_sid: subAccountSid } : {}),
  };
}

// ── The calling switch (review SSB-2) ────────────────────────────────────────────────────

export type SwitchNumber = {
  id: string; phone_number: string; twilio_sid: string | null; messaging_service_sid?: string | null;
  voice_enabled?: boolean | null; voice_configured_at?: string | null;
};

export const SWITCH_WARNINGS = {
  offStuck: "Calling is off, but your number couldn't be moved to voicemail just now, so callers hear that it can't take calls. Press \"Send calls to voicemail\" to try again.",
  offUnchecked: "Calling is off, but your number couldn't be checked just now. Reload this page to see where its calls go.",
  onNotReconnected: "Calling is on, but your number didn't reconnect. Press \"Connect this number for calls\" to try again.",
  // More than one number (migration 266): the same, said of the ones that didn't move.
  offStuckSome: "Calling is off, but some of your numbers couldn't be moved to voicemail just now, so their callers hear that they can't take calls. Press \"Send calls to voicemail\" to try again.",
  onNotReconnectedSome: "Calling is on, but some of your numbers didn't reconnect. Press \"Connect this number for calls\" on each of them to try again.",
} as const;

/**
 * phone_status_set, in the order it has to happen:
 *   1. The column first, both ways. OFF is also the safety control, so it lands before anything
 *      that can fail; ON only makes the Worker willing to answer.
 *   2. Then EVERY number follows (numberActionForSwitch), one at a time: off moves each connected
 *      number to voicemail, on reconnects each one the switch moved. A failure on one does not
 *      stop the others or undo the switch: the answer says what is left, and each number's
 *      voiceReady tells the screen which way its calls go. (Migration 266: a business can have
 *      more than one number, and a number left pointing at the Worker while calling is off drops
 *      its callers with no voicemail, review SSB-2.)
 * `number` is the first number's state, what a portal bundle from before 266 reads.
 * The dependencies are injected so a test drives the whole order without a database or Twilio.
 */
export async function switchCalling(on: boolean, deps: {
  writeStatus: (on: boolean) => Promise<{ ok: true } | { ok: false; noRow: true } | { ok: false; error: unknown }>;
  readNumbers: () => Promise<{ rows: SwitchNumber[] } | { error: unknown }>;
  toVoicemail: (n: SwitchNumber) => Promise<boolean>;
  connect: (n: SwitchNumber) => Promise<boolean>;
}): Promise<
  | { ok: false; noRow: true }
  | { ok: false; error: unknown }
  | {
    ok: true; phoneStatus: "on" | "off"; number: { voiceReady: boolean } | null;
    numbers: { id: string; voiceReady: boolean }[]; warning: string | null;
  }
> {
  const w = await deps.writeStatus(on);
  if (!w.ok) return w;
  const phoneStatus = on ? "on" : "off";
  const read = await deps.readNumbers();
  if ("error" in read) {
    return { ok: true, phoneStatus, number: null, numbers: [], warning: on ? null : SWITCH_WARNINGS.offUnchecked };
  }
  const rows = (read.rows ?? []).filter(Boolean);
  const many = rows.length > 1;
  const numbers: { id: string; voiceReady: boolean }[] = [];
  let stuck = false, notBack = false;
  for (const n of rows) {
    const act = numberActionForSwitch(on, n);
    if (act === "to_voicemail") {
      const moved = await deps.toVoicemail(n);
      if (!moved) stuck = true;
      numbers.push({ id: n.id, voiceReady: !moved });
    } else if (act === "connect") {
      const back = await deps.connect(n);
      if (!back) notBack = true;
      numbers.push({ id: n.id, voiceReady: back });
    } else {
      numbers.push({ id: n.id, voiceReady: n.voice_enabled === true });
    }
  }
  const warning = stuck ? (many ? SWITCH_WARNINGS.offStuckSome : SWITCH_WARNINGS.offStuck)
    : notBack ? (many ? SWITCH_WARNINGS.onNotReconnectedSome : SWITCH_WARNINGS.onNotReconnected)
    : null;
  return { ok: true, phoneStatus, number: numbers[0] ? { voiceReady: numbers[0].voiceReady } : null, numbers, warning };
}

// ── A later number joins texting (migration 266) ─────────────────────────────────────────

export type TextingAttachOutcome =
  | { ok: true; attached: boolean }
  | { ok: false; step: "sid" | "check" | "attach" | "clear_sms_url" | "record"; error: unknown };

/**
 * A builder whose texting is already on (sms_registrations 'active', its Messaging Service known)
 * gets another number into that service, so the number can text once its own carrier
 * registration clears (twilio-events moves the row to 'registered'; until then smsSend never sends
 * from it). portal-sms's adoption (adoptNumber.ts) in miniature, with the same _shared Twilio
 * helpers in the same order, and WITHOUT its two other writes: client_settings.sms_number stays the
 * main number (automatic texts stay on it), and the registration is not moved (it is already
 * active).
 *   1. In the service already? (a retry after Twilio acted and we did not record it)
 *   2. If not, attach it.
 *   3. Clear the number's own SmsUrl: the service's inbound URL (sms-inbound) takes its texts now.
 *   4. LAST, the row's messaging_service_sid: that column is what marks it as no longer
 *      calling-only, so a failure before it leaves a row the next press finishes.
 * Every step is safe to repeat. No network or database of its own; the caller injects both.
 */
export async function attachToTexting(
  o: { serviceSid: string; numberSid: string },
  deps: {
    inService: (serviceSid: string, numberSid: string) => Promise<boolean>;
    attach: (serviceSid: string, numberSid: string) => Promise<void>;
    clearSmsUrl: (numberSid: string) => Promise<void>;
    record: (patch: { messaging_service_sid: string; twilio_sid: string }) => Promise<{ error: unknown }>;
  },
): Promise<TextingAttachOutcome> {
  if (!/^PN[0-9a-f]{32}$/i.test(o.numberSid) || !/^MG[0-9a-f]{32}$/i.test(o.serviceSid)) {
    return { ok: false, step: "sid", error: { message: "not a number sid and a service sid" } };
  }
  let there: boolean;
  try { there = await deps.inService(o.serviceSid, o.numberSid); } catch (e) { return { ok: false, step: "check", error: e }; }
  if (!there) {
    try { await deps.attach(o.serviceSid, o.numberSid); } catch (e) { return { ok: false, step: "attach", error: e }; }
  }
  try { await deps.clearSmsUrl(o.numberSid); } catch (e) { return { ok: false, step: "clear_sms_url", error: e }; }
  const r = await deps.record({ messaging_service_sid: o.serviceSid, twilio_sid: o.numberSid });
  if (r.error) return { ok: false, step: "record", error: r.error };
  return { ok: true, attached: !there };
}

/** What the builder is told when a new number could not join texting (it still takes calls). */
export const TEXTING_JOIN_FAILED =
  "It takes calls now, but it couldn't be added to your texting setup just now. Press \"Use this number for texting too\" to try again.";
