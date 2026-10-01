// My Synergy Phone plan phase 6: texting ADOPTS the number a builder already has for calls.
//
// Plan D6 is one number per builder for calls AND texts, and calling never waits on text
// registration. So the Phone tab (portal-settings phone_buy_number) can buy a CALLING-ONLY
// number: an ordinary sms_numbers row with messaging_service_sid NULL and registration_status
// 'pending_registration', whose texts reach sms-inbound through the number's own SmsUrl. When the
// builder's carrier registration later clears, buy_number must use THAT number, never a second
// one: portal-sms's one-live-number count used to refuse ("This account already has a texting
// number"), which left the builder stuck, and that is why PHONE_SELF_SERVE could not open.
//
// What adopting does, and in this order (every step safe to repeat, so a failure anywhere is a
// retry that finishes the job rather than a second number or a second charge):
//   1. The number's PN… SID: the row's own, or found at Twilio by its E.164.
//   2. Into the builder's Messaging Service (_shared attachNumberToService), unless it is already
//      there (numberInService: a retry after Twilio acted and we did not record it).
//   3. Its own SmsUrl cleared: the Messaging Service's inbound URL (sms-inbound, set when the
//      service was created) takes its texts from now on.
//   4. client_settings.sms_number, then the registration (campaign_approved → number_pending,
//      exactly where buying a number leaves it), then LAST the row's messaging_service_sid: the
//      column is what marks the number as adopted, so writing it last means a failure before it
//      leaves a row this branch adopts again on the next press.
//
// ⚠️ NO WALLET HOLD, AND NO PURCHASE. The first month was held when the Phone tab bought the
// number, under portal-sms's own key (sms_num:<client>:<number>, phoneNumber.ts numberHoldKey),
// so adopting takes no hold at all, under that key or any other. Nothing here can rent a number.
//
// This file has no network and no database of its own; portal-sms index.ts injects both, and
// tests/phone/adoptNumber_test.ts drives every path against stubs. That now includes the whole
// adopt BRANCH of buy_number (adoptBranch: the state refusal, the adoption, what the builder is
// told and what is logged) and the two reads around it (buyPlanFromRead, numberRowWritten), so
// the handler in index.ts is wiring only (review BE-6).
//
// A RETRY IS ALWAYS REACHABLE (review BE-5). An adoption that stops after the registration moved
// to number_pending (its last write, the row's messaging_service_sid, failed) answers "Press it
// again to finish", and the server accepts that press in number_pending and active (ADOPT_STATES).
// The SMS tab offers the press in exactly those states, whenever a calling-only row is still
// there (portal/11-sms.jsx SMS_ADOPT_STATES), so the retry survives a reload.

export type LiveNumber = {
  id: string;
  phone_number: string;
  twilio_sid: string | null;
  messaging_service_sid: string | null;
};

/**
 * What buy_number does, from the tenant's live (unreleased) numbers, oldest first:
 *   none                                   → "buy" (the texting purchase, unchanged)
 *   one already in a Messaging Service     → "has_number" (the existing 409)
 *   otherwise, the oldest calling-only one → "adopt" it (the Phone tab reads the oldest too)
 */
export function buyPlan(live: LiveNumber[]):
  { kind: "buy" } | { kind: "has_number" } | { kind: "adopt"; number: LiveNumber } {
  const rows = (live ?? []).filter(Boolean);
  if (!rows.length) return { kind: "buy" };
  if (rows.some((n) => !!n.messaging_service_sid)) return { kind: "has_number" };
  return { kind: "adopt", number: rows[0] };
}

/** The registration states an adoption may run in. Before campaign_approved the carriers have
 *  not cleared the campaign, and moving the row to number_pending would skip that wait (the
 *  number picker only appears at campaign_approved for the same reason). number_pending and
 *  active are a retry of an adoption whose last write did not land. */
export const ADOPT_STATES = ["campaign_approved", "number_pending", "active"] as const;

export type AdoptOutcome =
  | { ok: true; numberSid: string; attached: boolean }
  | { ok: false; kind: "no_sid" }
  | { ok: false; kind: "twilio"; error: unknown; step: "find" | "check" | "attach" | "clear_sms_url" }
  | { ok: false; kind: "db"; error: unknown; step: "sms_number" | "registration" | "number_row" };

type Write = () => Promise<{ error: unknown } | { error: null }>;

export async function adoptCallingNumber(
  o: { serviceSid: string; number: LiveNumber; registrationStatus: string },
  deps: {
    findNumberSid: (e164: string) => Promise<string | null>;
    inService: (serviceSid: string, numberSid: string) => Promise<boolean>;
    attach: (serviceSid: string, numberSid: string) => Promise<void>;
    clearSmsUrl: (numberSid: string) => Promise<void>;
    setSmsNumber: (e164: string) => ReturnType<Write>;
    /** Only called when the registration is still at campaign_approved. */
    toNumberPending: () => ReturnType<Write>;
    recordNumber: (patch: { messaging_service_sid: string; twilio_sid: string }) => ReturnType<Write>;
  },
): Promise<AdoptOutcome> {
  const PN = /^PN[0-9a-f]{32}$/i;
  let numberSid = String(o.number.twilio_sid ?? "");
  if (!PN.test(numberSid)) {
    try {
      numberSid = String((await deps.findNumberSid(o.number.phone_number)) ?? "");
    } catch (e) {
      return { ok: false, kind: "twilio", error: e, step: "find" };
    }
    if (!PN.test(numberSid)) return { ok: false, kind: "no_sid" };
  }

  let there: boolean;
  try {
    there = await deps.inService(o.serviceSid, numberSid);
  } catch (e) {
    return { ok: false, kind: "twilio", error: e, step: "check" };
  }
  if (!there) {
    try {
      await deps.attach(o.serviceSid, numberSid);
    } catch (e) {
      return { ok: false, kind: "twilio", error: e, step: "attach" };
    }
  }
  try {
    await deps.clearSmsUrl(numberSid);
  } catch (e) {
    return { ok: false, kind: "twilio", error: e, step: "clear_sms_url" };
  }

  const s = await deps.setSmsNumber(o.number.phone_number);
  if (s.error) return { ok: false, kind: "db", error: s.error, step: "sms_number" };
  if (o.registrationStatus === "campaign_approved") {
    const r = await deps.toNumberPending();
    if (r.error) return { ok: false, kind: "db", error: r.error, step: "registration" };
  }
  const n = await deps.recordNumber({ messaging_service_sid: o.serviceSid, twilio_sid: numberSid });
  if (n.error) return { ok: false, kind: "db", error: n.error, step: "number_row" };
  return { ok: true, numberSid, attached: !there };
}

/** buy_number's read of the tenant's live numbers, decided. A failed read REFUSES: it used to
 *  read as "no numbers" and go on to buy a second one. */
export function buyPlanFromRead(res: { data: LiveNumber[] | null; error: unknown }):
  { kind: "read_failed"; error: unknown } | ReturnType<typeof buyPlan> {
  if (res.error) return { kind: "read_failed", error: res.error };
  return buyPlan(res.data ?? []);
}

/** The row write that marks the number adopted (`update … select("id")`). An update that matched
 *  no row (the number was released meanwhile) is not an adoption, and says so. */
export function numberRowWritten(res: { data: unknown[] | null; error: unknown }): { error: unknown } {
  if (res.error) return { error: res.error };
  return { error: (res.data ?? []).length ? null : { message: "the number row was not updated (released meanwhile?)" } };
}

export const ADOPT_TOO_EARLY =
  "Your number can start texting once the carriers approve your campaign. There's nothing to do until then.";
export const ADOPT_NO_SID =
  "Your number isn't on Structure Studio's phone account, so texting can't use it. Contact support.";
export const ADOPT_TWILIO_FAILED = "Couldn't connect your number for texting just now. Try again in a minute.";
export const ADOPT_WRITE_FAILED = "Your number is connected for texting, but that couldn't be saved just now. Press it again to finish.";

export type AdoptLog = { code: string; message: string; severity?: "error"; context?: Record<string, unknown> };
export type AdoptReply =
  | { ok: true; numberSid: string; attached: boolean }
  | { ok: false; status: number; error: string; log: AdoptLog | null };

/**
 * buy_number's adopt branch, all but the wiring: refuse before the carriers have cleared the
 * campaign (nothing is touched), adopt, and turn a stop into what the builder is told (our own
 * sentences; Twilio's text never reaches a browser) and what goes to app_errors (codes and our
 * own words, the step it stopped at).
 */
export async function adoptBranch(
  o: { serviceSid: string; number: LiveNumber; registrationStatus: string },
  deps: Parameters<typeof adoptCallingNumber>[1],
): Promise<AdoptReply> {
  if (!(ADOPT_STATES as readonly string[]).includes(o.registrationStatus)) {
    return { ok: false, status: 409, error: ADOPT_TOO_EARLY, log: null };
  }
  const adopted = await adoptCallingNumber(o, deps);
  if (adopted.ok) return adopted;
  if (adopted.kind === "no_sid") {
    return {
      ok: false, status: 409, error: ADOPT_NO_SID,
      log: { code: "sms_adopt_number_not_found", message: "The calling-only number has no Twilio SID and none was found by its E.164" },
    };
  }
  const e = adopted.error as { message?: string; code?: number } | null;
  return {
    ok: false, status: 502,
    error: adopted.kind === "twilio" ? ADOPT_TWILIO_FAILED : ADOPT_WRITE_FAILED,
    log: {
      code: adopted.kind === "twilio" ? "sms_adopt_number_twilio_failed" : "sms_adopt_number_write_failed",
      message: `Adopting the calling-only number stopped at ${adopted.step}: ${e?.message ?? "unknown"}`,
      severity: "error",
      context: { step: adopted.step, twilio_code: adopted.kind === "twilio" ? (e?.code ?? null) : null },
    },
  };
}
