// Who may START a texting registration (Workstream 2, phase 3; the review's correction 8).
//
// A builder's carrier registration lives in exactly one Twilio account for good: brands and
// campaigns cannot move between accounts, and one tenant is one account (migration 292's
// twilio_accounts_no_split). While TWILIO_SUBACCOUNTS is off, everything is made on the PARENT, so a
// builder who started registering then would be on the parent forever, the opposite of what
// Carolyn asked for on 2026-10-08 ("I don't want them under my business name"). So, like the Phone
// tab's PHONE_SELF_SERVE rollout (portal-settings/phone.ts), a NEW registration is refused until
// the switch is on.
//
// NEVER refused, so nobody already on the way is stranded:
//   * the switch on (the registration is then made in the builder's own sub-account);
//   * a registration that has already reached Twilio (anything made there, or a status past the
//     intake): it finishes where it started;
//   * for save_intake only, a draft already saved (status past 'none'): editing it makes nothing,
//     and the refusal comes at its first submit instead;
//   * our own internal account and any tenant pinned to the parent (a kind
//     'parent' twilio_accounts row): they live on the parent by decision.
// A pure module, so tests/phone drives every case; the reads are portal-sms's.

/** What a builder is told. */
export const SMS_SIGNUP_CLOSED_SENTENCE =
  "Text messaging isn't open to new businesses yet. Structure Studio will switch it on for your account when it's ready.";

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

/** null = allowed; otherwise the sentence to refuse with. */
export async function smsSignupRefusal(o: {
  action: "save_intake" | "advance";
  subaccountsOn: boolean;
  reg: RegistrationLike;
  /** Our internal account, or a parent pin. Asked only when nothing above already allows it. */
  onParentByDecision: () => Promise<boolean>;
}): Promise<string | null> {
  if (o.subaccountsOn) return null;
  if (registrationAtTwilio(o.reg)) return null;
  if (o.action === "save_intake" && o.reg && String(o.reg.status ?? "none") !== "none") return null;
  return (await o.onParentByDecision()) ? null : SMS_SIGNUP_CLOSED_SENTENCE;
}
