// Who may START a texting registration (Workstream 2, phase 3; the review's correction 8).
//
// A builder's carrier registration lives in exactly one Twilio account for good: brands and
// campaigns cannot move between accounts, and one tenant is one account (migration 292's
// twilio_accounts_no_split). While TWILIO_SUBACCOUNTS is off, everything is made on the PARENT, so a
// builder who started registering then would be on the parent forever, the opposite of what
// Carolyn asked for on 2026-10-08 ("I don't want them under my business name"). So, like the Phone
// tab's PHONE_SELF_SERVE rollout (portal-settings/phone.ts), a NEW registration is refused until
// the switch is on, or (switch "manual") until the builder's sub-account has been made by hand.
//
// NEVER refused, so nobody already on the way is stranded:
//   * the switch "on" (the registration is then made in the builder's own sub-account);
//   * a registration that has already reached Twilio (anything made there, or a status past the
//     intake): it finishes where it started;
//   * for save_intake only, a draft already saved (status past 'none'): editing it makes nothing,
//     and the refusal comes at its first submit instead;
//   * a tenant whose account is already decided (portal-sms accountDecided): our own internal
//     account, a tenant pinned to the parent (a kind 'parent' twilio_accounts row), one already
//     holding something on the parent (it lives there for good anyway), and with the switch
//     "manual" one with a sub-account of its own (the registration is made in it).
//
// ⚠️ SWITCH OFF AND A REGISTRATION IN A SUB-ACCOUNT (review M3). Off, every Twilio call runs as the
// parent, which cannot see a sub's brand or campaign: a submit would fail at Twilio, or worse, be
// recorded as a carrier failure. So it waits (SMS_PAUSED_SENTENCE), and portal-sms's status sweep
// leaves it alone. The rollback once builders are on sub-accounts is "manual", never off.
// A pure module, so tests/phone drives every case; the reads are portal-sms's.

import type { SubaccountsMode } from "../_shared/twilioAccount.ts";

/** What a builder is told. */
export const SMS_SIGNUP_CLOSED_SENTENCE =
  "Text messaging isn't open to new businesses yet. Structure Studio will switch it on for your account when it's ready.";

/** A registration that lives in the builder's own account while that account cannot be reached. */
export const SMS_PAUSED_SENTENCE =
  "Your texting setup is paused for a moment on our side. Nothing is lost; try again later, or contact Structure Studio.";

export type RegistrationLike = {
  status?: string | null;
  twilio_account_sid?: string | null;
  customer_profile_sid?: string | null;
  a2p_profile_sid?: string | null;
  brand_sid?: string | null;
  messaging_service_sid?: string | null;
  campaign_sid?: string | null;
} | null | undefined;

/** The statuses before anything is made at Twilio (portal-sms advanceOne's first stage runs from them). */
const BEFORE_TWILIO = new Set(["none", "intake", "aup_pending", "ready"]);

/** Has this registration made anything at Twilio (or moved past the intake)? */
export function registrationAtTwilio(reg: RegistrationLike): boolean {
  if (!reg) return false;
  if (reg.twilio_account_sid) return true;
  if ([reg.customer_profile_sid, reg.a2p_profile_sid, reg.brand_sid, reg.messaging_service_sid, reg.campaign_sid].some((v) => !!v)) return true;
  return !BEFORE_TWILIO.has(String(reg.status ?? "none"));
}

/** Off, and this registration lives in a sub-account: nothing may be done to it at Twilio now. */
export function registrationUnreachable(mode: SubaccountsMode, reg: RegistrationLike): boolean {
  return mode === "off" && !!reg?.twilio_account_sid;
}

/** null = allowed; otherwise the sentence to refuse with. */
export async function smsSignupRefusal(o: {
  action: "save_intake" | "advance";
  /** TWILIO_SUBACCOUNTS (twilioAccount.ts subaccountsMode). */
  mode: SubaccountsMode;
  reg: RegistrationLike;
  /** Is this tenant's account already decided (see the header)? Asked only when nothing above
   *  already answers. */
  accountDecided: () => Promise<boolean>;
}): Promise<string | null> {
  if (o.mode === "on") return null;
  if (registrationUnreachable(o.mode, o.reg)) return o.action === "advance" ? SMS_PAUSED_SENTENCE : null;
  if (registrationAtTwilio(o.reg)) return null;
  if (o.action === "save_intake" && o.reg && String(o.reg.status ?? "none") !== "none") return null;
  return (await o.accountDecided()) ? null : SMS_SIGNUP_CLOSED_SENTENCE;
}
