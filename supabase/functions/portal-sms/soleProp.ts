// No-EIN texting (Twilio's Sole Proprietor A2P tier), the parts of it that live in portal-sms:
// the operator's switch, the refusal while it is off, what the portal is told, the "reply YES"
// resend's cooldown, the plain sentences for the sole-prop rejection codes, and the ready stage's
// order (read a recorded profile's policy before building on it; Starter profile, then the Sole
// Proprietor trust product). The Twilio calls are _shared/twilioTrustHub.ts; this file makes none
// of its own except the injected reads, so tests/phone/smsSoleProp_test.ts drives it against stubs.
//
// ⚠️ SHIPS DARK (Ahsan 2026-10-27). client_settings.sms_sole_prop (migration 342) is off for every
// builder until an operator turns it on by SQL, and a database without the column reads off. Off,
// a builder who answers "no EIN" is refused with the sentence they got before this branch, word for
// word (NO_EIN_REFUSAL), and nothing the portal shows an EIN builder changes. Nothing here has run
// against a real Twilio account: no money was spent proving it, so it opens one builder at a time.
//
// ⚠️ PUBLIC REPO. No builder's name, number or address belongs in this file or its test: the only
// names in any output are the ones passed in at runtime.

import {
  POLICY_SOLE_PROP_TRUST_PRODUCT, POLICY_STARTER_CUSTOMER_PROFILE, SOLE_PROP_OTP_SENDER, normalizeBrandStatus, trustProductStatus,
  type TrustHubHttp, type TrustProductStatus,
} from "../_shared/twilioTrustHub.ts";
import { suggestedCopyForRow, type RegistrationCopyRow, type SuggestedCopy } from "../_shared/smsCopyTemplate.ts";
import { SOLE_PROP_NOT_STARTER_NOTE, SOLE_PROP_TRUST_PRODUCT_NOTE } from "../_shared/smsSoleProprietorNotes.ts";

export const SOLE_PROP_TIER = "sole_proprietor";

// deno-lint-ignore no-explicit-any
type Db = any;
// deno-lint-ignore no-explicit-any
type Row = any;

// ── The switch ───────────────────────────────────────────────────────────────────────────────

/** client_settings.sms_sole_prop, read TOLERANTLY: true only on a clean `true`. A database without
 *  migration 342 (42703, or a PostgREST that has not reloaded), a missing settings row, or any
 *  failed read is OFF, the posture portal-settings' library switch takes (library.ts
 *  readLibraryFlag). Off is the safe side every time: it refuses the route and spends nothing.
 *  Its own read, never added to the handler's website read: a select naming a column the database
 *  does not have fails WHOLE, and that read carries the consent-box switch and the website. */
export async function soleProprietorOn(admin: Db, clientId: string): Promise<boolean> {
  try {
    const { data, error } = await admin.from("client_settings").select("sms_sole_prop").eq("client_id", clientId).maybeSingle();
    if (error) return false;
    return (data as { sms_sole_prop?: unknown } | null)?.sms_sole_prop === true;
  } catch {
    return false;
  }
}

// ── The refusals ─────────────────────────────────────────────────────────────────────────────

/** The answer to "no EIN" while the switch is off: validateIntake's sentence from before
 *  2026-10-27, VERBATIM. It moved here when validateIntake learned the sole-proprietor rules,
 *  because this is where the switch is read; the portal's refusal box says the same thing. */
export const NO_EIN_REFUSAL =
  "Texting can only be set up for a business that has an EIN at the moment. Registering without " +
  "one goes through a different carrier process that we have not built yet — if that is your " +
  "situation, contact support and we will tell you where it stands.";

/** save_intake, switching from no EIN to having one after the carriers have the sole proprietor's
 *  profile or brand. */
export const TIER_SWITCH_SENTENCE =
  "Your registration has already gone to the carriers, so switching between having an EIN and not having one " +
  "needs a new registration. Contact support and we will set that up with you.";

/** save_intake, answering "no EIN" on an account that already holds a business profile (or a
 *  texting profile, or a brand) at the carriers. Most often that is the one the Phone tab made for
 *  caller ID, which is an EIN business's profile: a builder who has never submitted texting can
 *  still have one, so this must not say the registration "has gone to the carriers". */
export const SOLE_PROP_SWITCH_PROFILE_SENTENCE =
  "This account already has a business profile at the carriers (for example from setting up caller ID on the Phone tab), " +
  "so moving to registering without an EIN needs support. Contact support and we will sort it out with you.";

/**
 * May save_intake move this registration to `tier`? null = yes; otherwise the sentence (409).
 *   * Same route: always. "Route" is with an EIN (low_volume_standard, standard) or without one
 *     (sole_proprietor); a move between the two EIN tiers is what save_intake did before
 *     2026-10-27, unrefused, and still is. Editing the details is save_intake's job.
 *   * TOWARDS sole_proprietor: refused as soon as the row records ANY Twilio object, a customer
 *     profile (customer_profile_sid), a trust product (a2p_profile_sid) or a brand (brand_sid).
 *     None of them can belong to a sole proprietor: an EIN row only ever records the EIN tier's
 *     Secondary profile and A2P trust product, and portal-settings' phone_trust_profile writes a
 *     Secondary profile for caller ID onto a row that has never submitted texting at all. Until the
 *     2026-10-27 review this direction was allowed with a Secondary recorded (the sole-prop ready
 *     stage reads the policy and refuses), which TRAPPED the builder: the row became a
 *     sole_proprietor holding a Secondary profile, the rule below then refused the way back, and
 *     only hand-written SQL could free it. Refusing here keeps the invariant the rest of the route
 *     leans on: a sole_proprietor row never holds a profile that is not a Starter one.
 *   * AWAY FROM sole_proprietor: refused once a profile, trust product or brand is recorded. By the
 *     rule above, that profile is now necessarily a STARTER one (made by the sole-prop ready stage),
 *     and the EIN tier's ready stage would finish it against the SECONDARY policy and register a
 *     STANDARD brand on it (paid, and wrong). A brand either way round: Twilio's transition guide
 *     is a new profile, a new brand and a new campaign; the row would otherwise send the new tier's
 *     chain down the old brand's path (profile_pending sees brand_sid and skips to brand_pending).
 *     A sole_proprietor row with nothing recorded (the switch was off, or they never pressed
 *     Submit) moves back to the EIN route freely.
 */
export function tierSwitchRefusal(reg: Row, tier: string): string | null {
  if (!reg) return null;
  const fromSole = String(reg.brand_tier ?? "low_volume_standard") === SOLE_PROP_TIER;
  const toSole = tier === SOLE_PROP_TIER;
  if (fromSole === toSole) return null;
  const recorded = !!(reg.customer_profile_sid || reg.a2p_profile_sid || reg.brand_sid);
  if (!recorded) return null;
  return toSole ? SOLE_PROP_SWITCH_PROFILE_SENTENCE : TIER_SWITCH_SENTENCE;
}

/** What save_intake writes for a sole proprietor ON TOP of the EIN tier's echo. Still an echo
 *  only (the mobile and the street address go to Twilio, never here). The legal name is the
 *  PERSON's, built the way Twilio is sent it (soleProprietorBrandName, passed in), there is no
 *  EIN, and the website is optional. */
export function soleProprietorEcho(brandName: string, websiteUrl: unknown): Record<string, unknown> {
  return {
    legal_business_name: brandName || null,
    ein_last4: null,
    website_url: String(websiteUrl ?? "").trim() || null,
  };
}

// ── What the portal is told ──────────────────────────────────────────────────────────────────

/** The sole-proprietor limits the portal prints before anyone chooses this route (Twilio's
 *  sole-prop guide and its T-Mobile and 10DLC help articles, read 2026-10-27): one number, 1,000
 *  segments a day to T-Mobile (about 3,000 across the US carriers), and the "reply YES" text from
 *  Twilio's own number, valid 24 hours, to be answered within 30 days of the brand. Static. */
export const SOLE_PROP_LIMITS = Object.freeze({
  numbers: 1,
  dailyTMobile: 1000,
  dailyTotalApprox: 3000,
  otpSender: SOLE_PROP_OTP_SENDER,
  otpHours: 24,
  verifyWithinDays: 30,
});

/** brand_identity_status as the portal reads it: upper case, or null. */
export function identityStatusOf(reg: Row): string | null {
  const v = String(reg?.brand_identity_status ?? "").trim();
  return v ? v.toUpperCase() : null;
}

/** Is this registration waiting on the owner's YES (the only time a resend makes sense)? A sole
 *  proprietor's brand in brand_pending that Twilio has APPROVED and whose identity is not verified. */
export function otpWaiting(reg: Row): boolean {
  if (!reg || reg.brand_tier !== SOLE_PROP_TIER || reg.status !== "brand_pending" || !reg.brand_sid) return false;
  if (normalizeBrandStatus(String(reg.brand_status ?? "")) !== "APPROVED") return false;
  const id = identityStatusOf(reg);
  return id !== "VERIFIED" && id !== "VETTED_VERIFIED";
}

/** The resend's cooldown: ten minutes from the last one. Twilio allows ten a second, but each one
 *  texts a person; the button exists for "it never arrived", not for impatience. */
export const OTP_RESEND_COOLDOWN_MS = 10 * 60_000;
/** sms_registration_events.event_type of a resend that went to Twilio. */
export const OTP_RESENT_EVENT = "otp_resent";
/** ...and of one Twilio refused (the claim row, renamed and freed: see otpResendKey). */
export const OTP_RESEND_FAILED_EVENT = "otp_resend_failed";

/** When the next resend is allowed, or null for "now". */
export function otpResendAvailableAt(lastResentAt: string | null | undefined, now: number = Date.now()): string | null {
  const t = lastResentAt ? new Date(lastResentAt).getTime() : NaN;
  if (!Number.isFinite(t)) return null;
  const at = t + OTP_RESEND_COOLDOWN_MS;
  return at > now ? new Date(at).toISOString() : null;
}

/**
 * The claim's idempotency key (sms_registration_events.event_id, unique where not null): the
 * tenant plus the resend it FOLLOWS. Two presses at once both read the same newest resend (or
 * none) and both try this key, so the second one's insert is a 23505 and it sends nothing: the
 * twilio-events dedupe, used as a single-flight. The next resend follows a different row, so its
 * key is new. A resend Twilio refused has its claim renamed (otp_resend_failed) and its key
 * cleared, so it neither holds the cooldown nor the key, and a retry can claim it again.
 */
export function otpResendKey(clientId: string, previousId: string | null | undefined): string {
  return `otp_resent:${clientId}:${previousId || "first"}`;
}

/** The newest resend for this tenant: its id (the next key) and when it was. A failed read is an
 *  `error`, and the caller refuses rather than texting someone on a guess. */
export async function lastOtpResend(admin: Db, clientId: string): Promise<{ id: string | null; createdAt: string | null; error: unknown }> {
  const { data, error } = await admin.from("sms_registration_events")
    .select("id, created_at").eq("client_id", clientId).eq("event_type", OTP_RESENT_EVENT)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error) return { id: null, createdAt: null, error };
  const r = (data ?? null) as { id?: string | null; created_at?: string | null } | null;
  return { id: r?.id ?? null, createdAt: r?.created_at ?? null, error: null };
}

/** The suggested wording for a sole proprietor: the shared recipe (smsCopyTemplate.ts), with the
 *  description and every example opening on the PERSON's name. Error 30914 refuses a sole-prop
 *  campaign that does not name the sole proprietor, and the registered brand is their own first
 *  and last name. The name customers see on the tick box follows in brackets, so the opt-in
 *  answer, which quotes that box word for word and is left exactly as the recipe wrote it, still
 *  reads as the same business. No person's name on the row means no suggestion: the recipe's own
 *  rule, a sentence we cannot stand behind is worse than an empty field. */
export function soleProprietorCopy(base: SuggestedCopy | null, personName: unknown, companyName: unknown): SuggestedCopy | null {
  if (!base) return null;
  const person = String(personName ?? "").replace(/\s+/g, " ").trim();
  if (!person) return null;
  const co = String(companyName ?? "").trim();
  const label = !co || co.toLowerCase() === person.toLowerCase() ? person : `${person} (${co})`;
  const lead = (s: string) => (co && s.startsWith(co) ? label + s.slice(co.length) : s);
  return {
    description: lead(base.description),
    messageFlow: base.messageFlow,
    messageSamples: base.messageSamples.map(lead),
  };
}

/**
 * The keys view() adds for this route, spread at the END of portal-sms's projection. Every builder
 * gets the four new keys (an EIN builder's portal ignores them). For a sole proprietor ONLY it also
 * re-states the suggested wording through soleProprietorCopy, which is why it is spread last; for
 * every other tier that key is not touched, so an EIN builder's answer is what it was.
 */
export function soleProprietorView(
  reg: Row,
  ctx: {
    on: boolean; lastOtpResentAt: string | null;
    companyName: string; consentBoxOn: boolean; designerUrl: string; disclosureUrl: string;
  },
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    soleProprietorAvailable: ctx.on === true,
    identityStatus: identityStatusOf(reg),
    otpResendAvailableAt: otpWaiting(reg) ? otpResendAvailableAt(ctx.lastOtpResentAt) : null,
    soleProprietorLimits: SOLE_PROP_LIMITS,
  };
  if (reg?.brand_tier === SOLE_PROP_TIER) {
    const base = suggestedCopyForRow(reg as RegistrationCopyRow, {
      companyName: ctx.companyName, consentBoxOn: ctx.consentBoxOn,
      designerUrl: ctx.designerUrl, disclosureUrl: ctx.disclosureUrl,
    });
    out.suggestedCopy = soleProprietorCopy(base, reg?.legal_business_name, ctx.companyName);
  }
  return out;
}

// ── Attention notes ──────────────────────────────────────────────────────────────────────────
// The sentences, the sole-prop code mapping and the rule for clearing them moved to
// _shared/smsSoleProprietorNotes.ts on 2026-10-27, because twilio-events writes the same notes
// and one function may not import another's files. Re-exported here so every import of them from
// this file (portal-sms, tests/phone/smsSoleProp_test.ts) reads the same names as before.
export {
  brandEventErrors, clearSoleProprietorStepNote, errorCodesOf, isSoleProprietorStepNote,
  SOLE_PROP_EXPIRED_NOTE, SOLE_PROP_LATE_NOTE, SOLE_PROP_NO_USE_CASE_NOTE, SOLE_PROP_NOT_STARTER_NOTE, SOLE_PROP_OFF_NOTE,
  SOLE_PROP_STEP_NOTES, SOLE_PROP_TRUST_PRODUCT_NOTE, soleProprietorBrandNote, soleProprietorCampaignNote,
  type PortalRegistrationError,
} from "../_shared/smsSoleProprietorNotes.ts";

// ── The YES wait (advanceOne's brand_pending, sole proprietor) ───────────────────────────────

/** The brand counts as sent when its `brand_registered` event was written (advanceOne's
 *  profile_pending stage notes it the moment Twilio answers). null when there is none or the read
 *  fails: the 30-day note then simply is not given, nothing else changes. */
export async function brandRegisteredAt(admin: Db, clientId: string): Promise<number | null> {
  try {
    const { data, error } = await admin.from("sms_registration_events")
      .select("created_at").eq("client_id", clientId).eq("event_type", "brand_registered")
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (error || !data?.created_at) return null;
    const t = new Date(String(data.created_at)).getTime();
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

/** Approved, no YES yet: look again in ten minutes (the 60 the other tiers wait would leave the
 *  builder staring at "reply YES" for an hour after they had), and past 30 days since the brand was
 *  sent, say so once and slow back down to an hour: Twilio may expire it, and only support can
 *  remove and resend it. */
export function yesWait(registeredAt: number | null, now: number = Date.now()): { pollMins: number; late: boolean } {
  const late = registeredAt !== null && now - registeredAt > 30 * 24 * 60 * 60_000;
  return { pollMins: late ? 60 : 10, late };
}

// ── The ready stage (advanceOne's `ready`, sole proprietor) ──────────────────────────────────

/** The recorded profile's policy and review state (GET CustomerProfiles/{BU}). fetchCustomerProfile
 *  in the shared file answers status and email only, and the policy is the whole question here. */
export async function readCustomerProfile(profileSid: string, http: TrustHubHttp):
  Promise<{ policySid: string; status: TrustProductStatus | null }> {
  if (!/^BU[0-9a-f]{32}$/i.test(profileSid)) return { policySid: "", status: null };
  const p = await http("GET", `https://trusthub.twilio.com/v1/CustomerProfiles/${profileSid}`);
  return { policySid: String(p?.policy_sid ?? ""), status: trustProductStatus(p?.status) };
}

export type SoleReadyDeps = {
  /** advanceOne's set(): an update of this tenant's row that throws on failure. */
  set: (patch: Record<string, unknown>) => Promise<Row>;
  note: (type: string, detail: unknown) => Promise<void>;
  /** readCustomerProfile, bound to the tenant's account. */
  readProfile: (profileSid: string) => Promise<{ policySid: string; status: TrustProductStatus | null }>;
  /** fetchTrustProduct, bound to the tenant's account. */
  readTrustProduct: (sid: string) => Promise<{ policySid: string; status: TrustProductStatus | null }>;
  /** finishSecondaryCustomerProfile with POLICY_STARTER_CUSTOMER_PROFILE: link, then evaluate and
   *  submit a draft, each step read first. */
  finishStarter: (profileSid: string) => Promise<{ status: TrustProductStatus | null }>;
  /** createStarterCustomerProfile. A refused or unanswered primary link in a SUB-account is
   *  written down by the caller before it is rethrown, exactly as the EIN tier's create is. */
  createStarter: () => Promise<{ profileSid: string }>;
  /** createSoleProprietorTrustProduct on the Starter profile. */
  createTrustProduct: (profileSid: string) => Promise<{ a2pProfileSid: string }>;
  /** A profile Twilio REJECTED: throws (portal-sms's ProfileRejectedError, 409, before anything
   *  is held, bought or charged). */
  rejected: () => Promise<never>;
};

/**
 * The sole proprietor's stages 1 and 2, in the order that spends nothing on a wrong foundation:
 *   1. A profile already recorded is READ FIRST. Anything but a Starter profile is refused with a
 *      note. save_intake no longer lets a row that records a profile become a sole proprietor
 *      (tierSwitchRefusal), so this is the second fence, for a row switched before that rule
 *      existed (2026-10-27) or written by hand: the Sole Proprietor trust product accepts only a
 *      Starter profile, and the brand built on a wrong pair is a paid rejection. Rejected by
 *      Twilio: refused (deps.rejected). Otherwise it is FINISHED against the
 *      Starter policy (a half-made one from a refused cross-account link), which on a finished
 *      profile is two reads and nothing sent.
 *   2. None recorded: createStarterCustomerProfile.
 *   3. A trust product already recorded is read too, and anything but a Sole Proprietor one is
 *      refused the same way; none: createSoleProprietorTrustProduct on the Starter profile.
 *   4. Both written down, profile_pending, and any note an earlier refusal left is cleared.
 * Nothing here holds money or registers a brand: that is profile_pending's explicit press.
 */
export async function readySoleProprietor(reg: Row, deps: SoleReadyDeps, soon: (mins: number) => string): Promise<Row> {
  let profileSid = String(reg?.customer_profile_sid ?? "").trim();
  if (profileSid) {
    const prof = await deps.readProfile(profileSid);
    if (prof.policySid !== POLICY_STARTER_CUSTOMER_PROFILE) {
      // SID prefixes only, never a copy of anything Twilio holds.
      await deps.note("sole_prop_profile_not_starter", { policy: prof.policySid ? prof.policySid.slice(0, 8) : null });
      return await deps.set({ needs_attention: true, attention_note: SOLE_PROP_NOT_STARTER_NOTE });
    }
    if (prof.status === "twilio-rejected") {
      await deps.note("profile_rejected", { tier: SOLE_PROP_TIER });
      return await deps.rejected();
    }
    const fin = await deps.finishStarter(profileSid);
    if (fin.status === "twilio-rejected") {
      await deps.note("profile_rejected", { tier: SOLE_PROP_TIER });
      return await deps.rejected();
    }
  } else {
    profileSid = (await deps.createStarter()).profileSid;
  }

  let a2pProfileSid = String(reg?.a2p_profile_sid ?? "").trim();
  if (a2pProfileSid) {
    const tp = await deps.readTrustProduct(a2pProfileSid);
    if (tp.policySid !== POLICY_SOLE_PROP_TRUST_PRODUCT) {
      await deps.note("sole_prop_trust_product_mismatch", { policy: tp.policySid ? tp.policySid.slice(0, 8) : null });
      return await deps.set({ customer_profile_sid: profileSid, needs_attention: true, attention_note: SOLE_PROP_TRUST_PRODUCT_NOTE });
    }
  } else {
    a2pProfileSid = (await deps.createTrustProduct(profileSid)).a2pProfileSid;
  }

  await deps.note("profiles_created", { profileSid, a2pProfileSid, tier: SOLE_PROP_TIER });
  return await deps.set({
    customer_profile_sid: profileSid,
    a2p_profile_sid: a2pProfileSid,
    status: "profile_pending",
    next_poll_at: soon(2),
    needs_attention: false,
    attention_note: null,
  });
}
