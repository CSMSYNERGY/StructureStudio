// My Synergy Phone plan phase 6 — caller-ID trust for a builder's number (plan section 14, "Caller ID
// reputation"): SHAKEN/STIR, so Twilio signs the builder's calls at level A, and Voice Integrity,
// which registers the number with the carriers' spam engines against "Spam Likely".
//
// OPERATOR-ONLY, NEVER AUTOMATIC. portal-settings' phone_trust_setup and phone_trust_status are
// refused to anyone who is not a CSM Synergy operator who can WRITE (trustOperatorAllowed: an
// operator in view-as with can_write, or an app_operators member with can_write on their own
// tenant; a support-only operator is refused either way), and PHONE_SELF_SERVE does not open
// them: each one submits the builder's legal identity to a Twilio review or writes the number
// row, and Voice Integrity may be billed. Nothing calls them on a timer, a webhook or a page load.
//
// ONE AT A TIME PER NUMBER (review BE-2). The setup looks for an existing Trust Product and
// creates one when there is none; two presses at once (two operators, two tabs) would both miss
// and both create. runTrustSetup therefore takes a claim first (sms_numbers.caller_id_lock_until,
// migration 255, the same conditional-update pattern as portal-sms's advance_lock_until) and
// refuses with 409 while another run holds it.
//
// This file is the part that runs without a network: which business profile the number goes on,
// when a profile is not ready, what the Phone tab is told, and the ORDER of the setup (read the
// profile, refuse, write the Trust Product down the moment it exists, then the result). The
// Twilio calls themselves are _shared/twilioTrustHub.ts (setupVoiceTrust, fetchTrustProduct,
// fetchCustomerProfile), injected here so tests/phone/phoneTrust_test.ts drives every path
// against stubs. The handlers in index.ts do the reads, the writes and the gate.
//
// Where it is recorded: sms_numbers.shaken_* / voice_integrity_* / caller_id_checked_at, and the
// setup's claim caller_id_lock_until (migration 255). They are read in a SEPARATE select from the number itself, so a deploy that
// lands before 255 is applied answers "not available yet" instead of failing the Phone tab.
//
// WORKSTREAM 2, PHASE 6:
//   * CNAM, the third kind (the business's name on the called party's screen): sms_numbers.cnam_*
//     (migration 297), read in a select of its OWN again (CNAM_COLUMNS), so before 297 is applied
//     CNAM alone reads "not available yet" and SHAKEN/STIR and Voice Integrity work as before.
//   * A CALLING-ONLY builder (a number for calls, no texting registration yet) has no business
//     profile, so every caller-ID press was refused with nowhere to go. phone_trust_profile (an
//     operator's, runTrustProfile below) makes that profile from the business's details, in the
//     builder's own Twilio account, and writes it where the texting registration keeps it
//     (sms_registrations.customer_profile_sid), so trustProfileFor finds it and texting later
//     reuses it instead of making a second.

import {
  CNAM_INFO_REQUIRED, PrimaryProfileLinkError, TrustHubError, trustProductStatus, validateIntake, VOICE_INTEGRITY_INFO_REQUIRED,
  voiceTrustFriendlyName, type BuilderIntake, type TrustProductStatus, type VoiceIntegrityInfo, type VoiceTrustKind,
  type VoiceTrustResult, type VoiceTrustSetup,
} from "../_shared/twilioTrustHub.ts";

/** The number row's caller-ID columns (migration 255), and the id they are keyed by. */
export const TRUST_COLUMNS =
  "id, shaken_trust_product_sid, shaken_status, voice_integrity_trust_product_sid, voice_integrity_status, caller_id_checked_at";
/** CNAM's own columns (migration 297), read in a select of their own (see the header). */
export const CNAM_COLUMNS = "cnam_trust_product_sid, cnam_status, cnam_display_name";

export type TrustRow = {
  id?: string;
  shaken_trust_product_sid?: string | null;
  shaken_status?: string | null;
  voice_integrity_trust_product_sid?: string | null;
  voice_integrity_status?: string | null;
  cnam_trust_product_sid?: string | null;
  cnam_status?: string | null;
  cnam_display_name?: string | null;
  caller_id_checked_at?: string | null;
};

/** Where each product lives on the row. */
type SidCol = "shaken_trust_product_sid" | "voice_integrity_trust_product_sid" | "cnam_trust_product_sid";
type StatusCol = "shaken_status" | "voice_integrity_status" | "cnam_status";
export const TRUST_COLS: Record<VoiceTrustKind, { sid: SidCol; status: StatusCol }> = {
  shaken_stir: { sid: "shaken_trust_product_sid", status: "shaken_status" },
  voice_integrity: { sid: "voice_integrity_trust_product_sid", status: "voice_integrity_status" },
  cnam: { sid: "cnam_trust_product_sid", status: "cnam_status" },
};

/** The one refusal a non-operator gets from either action. */
export const TRUST_OPERATOR_SENTENCE =
  "Caller ID registration is set up by Structure Studio. Ask us and we'll register your number.";

/**
 * May this caller register or check caller ID? (review BE-3)
 *   * In view-as (`operator` is resolveTenant's ctx.operator): only with can_write, and never a
 *     support-only operator. resolveTenant does not refuse a read-only operator on a READ-level
 *     action, and these actions write the number row (and call Twilio), whatever their GATES line.
 *   * Otherwise: an app_operators member (read on demand, once) with can_write and not
 *     support-only, acting on their own tenant (the pilot's owners). A failed read is a no.
 */
export async function trustOperatorAllowed(o: {
  operator: { canWrite: boolean; supportOnly: boolean } | null;
  ownOperatorRow: () => Promise<{ can_write?: boolean | null; support_only?: boolean | null } | null>;
}): Promise<boolean> {
  if (o.operator) return o.operator.canWrite === true && o.operator.supportOnly !== true;
  let row: { can_write?: boolean | null; support_only?: boolean | null } | null = null;
  try { row = await o.ownOperatorRow(); } catch { return false; }
  return !!row && row.can_write === true && row.support_only !== true;
}

/** How long one setup may hold the number (portal-sms's advance uses the same five minutes). A
 *  run always releases it; this only bounds a run that died without getting to. */
export const TRUST_LOCK_MS = 5 * 60_000;
export const TRUST_BUSY_SENTENCE =
  "This number's caller ID registration is already being worked on. Give it a minute, then check its status.";

/** Which product the request is about: "shaken_stir" (the default, plan item a),
 *  "voice_integrity" or "cnam" (Workstream 2, phase 6). Anything else is refused rather than guessed. */
export function parseTrustProduct(raw: unknown): VoiceTrustKind | null {
  if (raw === undefined || raw === null || raw === "") return "shaken_stir";
  return raw === "shaken_stir" || raw === "voice_integrity" || raw === "cnam" ? raw : null;
}

const BU = /^BU[0-9a-f]{32}$/i;

// ── CNAM takes US standard local numbers only (review 2026-10-09) ─────────────────────────────
// Twilio's CNAM guide: "US local long-code" numbers; not toll-free, not Canadian. Our purchases are
// US-only (AvailablePhoneNumbers/US), but a moved number (phone_adopt_number) can be Canadian, so
// phone_trust_setup refuses those for CNAM before anything is sent (a Trust Product Twilio would
// only reject). Toll-free: the 8XX codes. Canada: its geographic area codes in service or
// announced, plus 600 (non-geographic), from the NANP list (Wikipedia's, read 2026-10-09);
// reserved-only codes are left out. A code missing here only means Twilio rejects it instead.
const TOLL_FREE_NPA = new Set(["800", "833", "844", "855", "866", "877", "888"]);
const CANADA_NPA = new Set([
  "204", "226", "236", "249", "250", "257", "263", "289", "306", "343", "354", "365", "367", "368", "382",
  "403", "416", "418", "428", "431", "437", "438", "450", "468", "474", "506", "514", "519", "548", "579",
  "581", "584", "587", "600", "604", "613", "639", "647", "672", "683", "705", "709", "742", "753", "778",
  "780", "782", "807", "819", "825", "867", "873", "879", "902", "905", "942",
]);

/** Why this number cannot carry a CNAM registration, or null (a US local number). */
export function cnamNumberRefusal(e164: unknown): string | null {
  const m = /^\+1([2-9]\d{2})[2-9]\d{6}$/.exec(String(e164 ?? "").trim());
  if (!m) return "Caller name (CNAM) works only for US local numbers, and this one isn't.";
  if (TOLL_FREE_NPA.has(m[1])) return "Caller name (CNAM) works only for US local numbers, not toll-free ones.";
  if (CANADA_NPA.has(m[1])) return "Caller name (CNAM) works only for US local numbers, not Canadian ones.";
  return null;
}

/**
 * The business profile the number is assigned to.
 *   * The builder's own Secondary Customer Profile (sms_registrations.customer_profile_sid,
 *     created by the texting registration's first submit) — the ISV architecture every other
 *     Trust Hub object here already follows.
 *   * ONLY for an internal tenant (client_settings.internal_account, _shared/internalTenant.ts)
 *     with no secondary profile of its own: the platform's primary profile,
 *     TWILIO_PRIMARY_PROFILE_SID. It is OUR business, so its calls are ours to vouch for.
 *     A customer is never put on the primary profile: that would sign their calls as us.
 *   * An internal tenant whose number is ALREADY on the primary profile (an operator did it by
 *     hand in the Console, as the pilot's number may have been) stays there even when it also
 *     has a secondary: a number sits on one business profile, so moving it would only fail.
 *     `numberOnPrimary` is only ever asked for an internal tenant.
 */
export function trustProfileFor(o: {
  secondaryProfileSid: string | null; internal: boolean; primaryProfileSid: string | null; numberOnPrimary?: boolean;
}): { ok: true; profileSid: string; which: "secondary" | "primary" } | { ok: false; error: string; code?: string } {
  const sec = String(o.secondaryProfileSid ?? "").trim();
  const pri = String(o.primaryProfileSid ?? "").trim();
  if (o.internal && o.numberOnPrimary && BU.test(pri)) return { ok: true, profileSid: pri, which: "primary" };
  if (BU.test(sec)) return { ok: true, profileSid: sec, which: "secondary" };
  if (o.internal) {
    if (BU.test(pri)) return { ok: true, profileSid: pri, which: "primary" };
    return { ok: false, error: "This account has no business profile at Twilio, and the platform's own profile isn't configured on this server." };
  }
  // A builder with no profile yet: one who only calls, or whose texting is not submitted. Not a
  // dead end any more (Workstream 2, phase 6): Structure Studio makes the profile from the
  // business's details (phone_trust_profile), or the Text Messaging registration makes it.
  return { ok: false, code: NO_PROFILE_CODE, error: NO_PROFILE_SENTENCE };
}

/** The refusal's code, which the Phone tab answers with the business-profile form (operators). */
export const NO_PROFILE_CODE = "no_business_profile";
export const NO_PROFILE_SENTENCE =
  "Caller ID registration needs this business's details at Twilio first. Structure Studio adds them here, or the Text Messaging registration adds them when it is submitted.";

export type TrustProfileChoice =
  | { ok: true; profileSid: string; which: "secondary" | "primary" }
  | { ok: false; kind: "refused"; status: 409; error: string; code?: string }
  | { ok: false; kind: "twilio"; status: 502; error: string; code: number; detail: string };

/**
 * trustProfileFor, with the one Twilio read it may need: is an INTERNAL tenant's number already on
 * the platform's primary profile? That read decides only when the tenant ALSO has a secondary
 * (with none, the primary is the answer anyway), so it is made only then.
 *
 * ⚠️ FAIL CLOSED (review BE-4). A failed read used to answer "not on the primary", and the setup
 * then assigned the number to the secondary profile on a guess, when a number sits on one business
 * profile. Now a failed read is a 502 and nothing is sent. A bug (not a TrustHubError) is thrown.
 */
export async function chooseTrustProfile(
  o: { secondaryProfileSid: string | null; internal: boolean; primaryProfileSid: string | null; numberSid: string },
  deps: { numberOnProfile: (profileSid: string, numberSid: string) => Promise<boolean> },
): Promise<TrustProfileChoice> {
  const pri = String(o.primaryProfileSid ?? "").trim();
  const sec = String(o.secondaryProfileSid ?? "").trim();
  let numberOnPrimary = false;
  if (o.internal && BU.test(pri) && BU.test(sec)) {
    try {
      numberOnPrimary = await deps.numberOnProfile(pri, o.numberSid);
    } catch (e) {
      if (!(e instanceof TrustHubError)) throw e;
      return {
        ok: false, kind: "twilio", status: 502, code: e.code, detail: `primary profile check: ${e.message}`,
        error: `Couldn't check with Twilio which business profile this number is on${e.code ? ` (error ${e.code})` : ""}. Nothing was sent; try again in a minute.`,
      };
    }
  }
  const prof = trustProfileFor({ secondaryProfileSid: o.secondaryProfileSid, internal: o.internal, primaryProfileSid: o.primaryProfileSid, numberOnPrimary });
  return prof.ok ? prof : { ok: false, kind: "refused", status: 409, error: prof.error, ...(prof.code ? { code: prof.code } : {}) };
}

const STATUS_WORDS: Record<TrustProductStatus, string> = {
  "draft": "not submitted yet",
  "pending-review": "waiting for Twilio's review",
  "in-review": "being reviewed by Twilio",
  "twilio-rejected": "rejected by Twilio",
  "twilio-approved": "approved",
};

/** null = the business profile is approved, go ahead. Both Twilio guides require an APPROVED
 *  business profile ("To obtain an approved Voice Integrity bundle, you must ... Have an Approved
 *  Primary or Secondary Business Profile"), so submitting on anything else only buys a rejection. */
export function profileRefusal(status: TrustProductStatus | null): string | null {
  if (status === "twilio-approved") return null;
  const now = status ? STATUS_WORDS[status] : "in a state we don't recognise";
  return `This business's profile at Twilio is ${now}. Caller ID registration can start once Twilio has approved it.`;
}

export type CallerIdView = {
  available: boolean;
  shakenStir: { registered: boolean; status: TrustProductStatus | null };
  voiceIntegrity: { registered: boolean; status: TrustProductStatus | null };
  /** Workstream 2, phase 6. `available: false` = migration 297 is not applied yet (only CNAM is
   *  unavailable then). The display name is what callers see, so it is shown; no SID is. */
  cnam: { available: boolean; registered: boolean; status: TrustProductStatus | null; displayName: string | null };
  checkedAt: string | null;
};

/** What the Phone tab is told. `available: false` = migration 255 is not applied yet;
 *  `cnamAvailable: false` = 297 is not (by default: the row was read without CNAM's columns). No SIDs. */
export function callerIdView(row: TrustRow | null, available = true, cnamAvailable = !!row && "cnam_trust_product_sid" in row): CallerIdView {
  const r = row ?? {};
  const cnamOn = available && cnamAvailable;
  return {
    available,
    shakenStir: { registered: !!r.shaken_trust_product_sid, status: trustProductStatus(r.shaken_status) },
    voiceIntegrity: { registered: !!r.voice_integrity_trust_product_sid, status: trustProductStatus(r.voice_integrity_status) },
    cnam: {
      available: cnamOn,
      registered: cnamOn && !!r.cnam_trust_product_sid,
      status: cnamOn ? trustProductStatus(r.cnam_status) : null,
      displayName: cnamOn ? (r.cnam_display_name ?? null) : null,
    },
    checkedAt: r.caller_id_checked_at ?? null,
  };
}

/** A row write that failed partway: nothing more is sent to Twilio after it (the rule portal-sms
 *  follows after its Messaging Service orphan), and the Trust Product it was recording is found
 *  again by its FriendlyName on the next press. */
class TrustWriteError extends Error {
  readonly inner: unknown;
  constructor(inner: unknown) {
    super("caller-ID row write failed");
    this.name = "TrustWriteError";
    this.inner = inner;
  }
}

export type TrustSetupOutcome =
  | { ok: true; result: VoiceTrustResult }
  | { ok: false; kind: "refused"; status: number; error: string }
  | { ok: false; kind: "twilio"; status: number; error: string; code: number; detail: string }
  | { ok: false; kind: "db"; error: unknown };

type Write = (patch: Record<string, unknown>) => Promise<{ ok: true } | { ok: false; error: unknown }>;

function twilioFail(e: TrustHubError): TrustSetupOutcome {
  return {
    ok: false, kind: "twilio", status: 502, code: e.code, detail: e.message,
    // Codes only: Twilio's bodies echo what was submitted (a representative's email, the notes).
    error: `Twilio didn't accept the caller ID registration${e.code ? ` (error ${e.code})` : ""}. Anything already done is kept; press it again to carry on from there.`,
  };
}

/** The number's single-flight claim. `claim` is ONE conditional statement (set the lock only
 *  where it is empty or expired, and say whether a row changed); `release` clears only the
 *  claim this run took. */
export type TrustLock = {
  claim: () => Promise<{ ok: true } | { ok: false; busy: true } | { ok: false; busy: false; error: unknown }>;
  release: () => Promise<void>;
};

/**
 * phone_trust_setup, in the order it has to happen:
 *   0. Claim the number (TrustLock). Held by another run → 409, and nothing else happens.
 *   1. Read the business profile. Not approved → refuse, and nothing is sent to Twilio.
 *   2. setupVoiceTrust (_shared), which calls back the moment the Trust Product exists; that SID
 *      is written to the row BEFORE the remaining steps, so a failure after it is a retry that
 *      carries on, never a second product.
 *   3. The outcome (status, checked-at) is written.
 *   4. The claim is released, however 1-3 ended (a failed release only waits out TRUST_LOCK_MS).
 */
export async function runTrustSetup(
  o: {
    kind: VoiceTrustKind; clientId: string; numberSid: string; profileSid: string;
    existingSid: string | null; info: VoiceIntegrityInfo | null;
    /** CNAM's display name (parseCnamDisplayName's), or null. */
    cnamName?: string | null;
  },
  deps: {
    lock: TrustLock;
    fetchProfile: (profileSid: string) => Promise<{ status: TrustProductStatus | null; email: string }>;
    setup: (s: VoiceTrustSetup) => Promise<VoiceTrustResult>;
    write: Write;
    now?: () => string;
  },
): Promise<TrustSetupOutcome> {
  const claimed = await deps.lock.claim();
  if (!claimed.ok) {
    return claimed.busy
      ? { ok: false, kind: "refused", status: 409, error: TRUST_BUSY_SENTENCE }
      : { ok: false, kind: "db", error: claimed.error };
  }
  try {
    return await trustSetupClaimed(o, deps);
  } finally {
    try { await deps.lock.release(); } catch { /* the claim expires on its own (TRUST_LOCK_MS) */ }
  }
}

async function trustSetupClaimed(
  o: Parameters<typeof runTrustSetup>[0],
  deps: Parameters<typeof runTrustSetup>[1],
): Promise<TrustSetupOutcome> {
  const now = deps.now ?? (() => new Date().toISOString());
  const cols = TRUST_COLS[o.kind];
  try {
    const profile = await deps.fetchProfile(o.profileSid);
    const why = profileRefusal(profile.status);
    if (why) return { ok: false, kind: "refused", status: 409, error: why };
    if (!profile.email) {
      return { ok: false, kind: "refused", status: 409, error: "This business's profile at Twilio has no contact email, which the registration needs. Add one to the profile first." };
    }
    const result = await deps.setup({
      kind: o.kind,
      profileSid: o.profileSid,
      numberSid: o.numberSid,
      email: profile.email,
      friendlyName: voiceTrustFriendlyName(o.clientId, o.kind),
      existingSid: o.existingSid,
      voiceIntegrity: o.info,
      cnam: o.kind === "cnam" && o.cnamName ? { displayName: o.cnamName } : null,
      onTrustProduct: async (sid, status) => {
        const w = await deps.write({ [cols.sid]: sid, [cols.status]: status, caller_id_checked_at: now() });
        if (!w.ok) throw new TrustWriteError(w.error);
      },
    });
    // CNAM: the name Twilio now holds, once it has been sent (created, or replaced on a resubmit).
    const named = o.kind === "cnam" && o.cnamName && (result.endUserCreated || result.endUserUpdated)
      ? { cnam_display_name: o.cnamName } : {};
    const w = await deps.write({ [cols.sid]: result.trustProductSid, [cols.status]: result.status, caller_id_checked_at: now(), ...named });
    if (!w.ok) return { ok: false, kind: "db", error: w.error };
    return { ok: true, result };
  } catch (e) {
    if (e instanceof TrustWriteError) return { ok: false, kind: "db", error: e.inner };
    if (e instanceof TrustHubError) {
      if (e.message === VOICE_INTEGRITY_INFO_REQUIRED) {
        return { ok: false, kind: "refused", status: 400, error: "Answer the Voice Integrity questions first: what the business uses calls for, how many people work there, and about how many calls it makes a day." };
      }
      if (e.message === CNAM_INFO_REQUIRED) {
        return { ok: false, kind: "refused", status: 400, error: "Enter the name callers should see (up to 15 characters) first." };
      }
      return twilioFail(e);
    }
    throw e;
  }
}

export type TrustStatusOutcome =
  | { ok: true; view: CallerIdView; errorCodes: { shakenStir: number[]; voiceIntegrity: number[]; cnam: number[] }; changed: boolean }
  | { ok: false; kind: "twilio"; status: number; error: string; code: number; detail: string }
  | { ok: false; kind: "db"; error: unknown };

/**
 * phone_trust_status: read each recorded Trust Product from Twilio and store what it says. A
 * product Twilio no longer has (404, deleted in the Console) is cleared from the row, so the next
 * setup builds a new one instead of reporting a ghost. Rejection reasons come back as codes.
 */
export async function runTrustStatus(
  row: TrustRow,
  deps: {
    fetchTrustProduct: (sid: string) => Promise<{ status: TrustProductStatus | null; errorCodes: number[] }>;
    write: Write;
    now?: () => string;
  },
): Promise<TrustStatusOutcome> {
  const now = deps.now ?? (() => new Date().toISOString());
  const patch: Record<string, unknown> = {};
  const errorCodes = { shakenStir: [] as number[], voiceIntegrity: [] as number[], cnam: [] as number[] };
  const next: TrustRow = { ...row };
  try {
    // CNAM only when its columns were read (migration 297 applied): a row without them has no
    // CNAM to check, and writing one would fail the whole update.
    const kinds = (["shaken_stir", "voice_integrity", "cnam"] as const).filter((k) => k !== "cnam" || "cnam_trust_product_sid" in row);
    for (const kind of kinds) {
      const cols = TRUST_COLS[kind];
      const sid = String(row[cols.sid] ?? "");
      if (!BU.test(sid)) continue;
      try {
        const t = await deps.fetchTrustProduct(sid);
        patch[cols.status] = t.status;
        next[cols.status] = t.status;
        errorCodes[kind === "shaken_stir" ? "shakenStir" : kind === "cnam" ? "cnam" : "voiceIntegrity"] = t.errorCodes;
      } catch (e) {
        if (!(e instanceof TrustHubError && e.status === 404)) throw e;
        patch[cols.sid] = null;
        patch[cols.status] = null;
        next[cols.sid] = null;
        next[cols.status] = null;
      }
    }
  } catch (e) {
    if (e instanceof TrustHubError) {
      return { ok: false, kind: "twilio", status: 502, code: e.code, detail: e.message,
        error: `Couldn't read the caller ID registration from Twilio just now${e.code ? ` (error ${e.code})` : ""}. Try again in a minute.` };
    }
    throw e;
  }
  const changed = Object.keys(patch).length > 0;
  if (changed) {
    patch.caller_id_checked_at = now();
    next.caller_id_checked_at = patch.caller_id_checked_at as string;
    const w = await deps.write(patch);
    if (!w.ok) return { ok: false, kind: "db", error: w.error };
  }
  return { ok: true, view: callerIdView(next), errorCodes, changed };
}

// ── phone_trust_profile: the business profile for a builder who only calls ─────────────────────
// (Workstream 2, phase 6.) Caller ID trust is built on the builder's own Secondary Customer Profile,
// and until now only the texting registration's first submit made one, so a builder who only CALLS
// could never be registered (trustProfileFor's refusal had nowhere to send anyone). An operator
// now makes it from the business's details, in the builder's own Twilio account (their sub-account,
// or the parent for a builder who lives there), linked to the parent's primary profile exactly as
// texting would link it, and it is written where texting keeps it: sms_registrations.
// customer_profile_sid. trustProfileFor then finds it, and texting's first submit REUSES it (portal-
// sms advanceOne's ready stage) instead of making a second.
//
// The details are typed by the operator (prefilled from what the builder saved): the registration
// keeps only an echo of them (name, EIN's last four, email domain, website), never the EIN, the
// address or a person's mobile, and neither does this. The profile goes to Twilio's review; caller
// ID can be registered once Twilio approves it (profileRefusal), usually within a few days.

/** The texting registration's columns phone_trust_profile reads. */
export type RegistrationRow = {
  status?: string | null; customer_profile_sid?: string | null; twilio_account_sid?: string | null;
  legal_business_name?: string | null; ein_last4?: string | null; rep_email_domain?: string | null; website_url?: string | null;
} | null;

export type TrustProfileOutcome =
  /** created: a profile was made now. finished: an existing one was linked or submitted now.
   *  status: where Twilio's review of a recorded profile stands (read by `finish`). */
  | { ok: true; created: boolean; finished: boolean; status?: TrustProductStatus | null }
  | { ok: false; kind: "refused"; status: number; error: string; problems?: string[] }
  /** recorded: the profile Twilio made was written down anyway (a sub-account's link that failed),
   *  so the next press finishes it rather than making another. */
  | { ok: false; kind: "twilio"; status: 502; error: string; code: number; detail: string; recorded: boolean }
  | { ok: false; kind: "db"; error: unknown };

export const TRUST_PROFILE_INTERNAL_SENTENCE =
  "Our own account's calls use the platform's business profile, so there is nothing to add here.";
/** A recorded profile Twilio rejected: nothing here can change a submitted profile's details. */
export const TRUST_PROFILE_REJECTED_SENTENCE =
  "Twilio rejected this business's profile. Correct it in Twilio's Console (this business's own account, Trust Hub, Customer profiles) and submit it again there; caller ID and texting wait for it.";

/**
 * phone_trust_profile, in the order it has to happen:
 *   1. Our internal account: refused (it uses the primary profile).
 *   2. A profile already recorded: nothing is made. Under the registration's lock it is FINISHED
 *      (the primary link and the submit, each read first: a finished profile costs two reads and
 *      sends nothing), on the parent as in a sub-account, and one Twilio rejected is reported
 *      (TRUST_PROFILE_REJECTED_SENTENCE).
 *   3. The details, checked by the same rules texting uses (validateIntake, EIN required: CNAM and
 *      the carriers need it, and no-EIN registration is not built).
 *   4. The registration's lock (advance_lock_until, the one portal-sms's submit takes, so this and a
 *      texting submit can never both make a profile). Busy → 409.
 *   5. In a sub-account, the registration names its account BEFORE anything is made there (292's
 *      twilio_parent_holdings must never read it as the parent's; 295's trigger requires it).
 *   6. The profile, linked to the primary. If the link fails (refused, or never answered):
 *        in a SUB-account the profile it stopped on is written down (step 7's column) and the next
 *        press finishes it, as portal-sms does;
 *        on the PARENT nothing is written and the next press makes a fresh one, as before
 *        sub-accounts. (Review 2026-10-09: written down on the parent it was never finished, and
 *        texting there would have built a billed brand on an unlinked draft.)
 *      Anything else from Twilio is reported with nothing written.
 *   7. customer_profile_sid, and the echo where the registration has none of its own yet.
 *   8. The lock is released, however it ended.
 */
export async function runTrustProfile(
  o: { clientId: string; intake: Partial<BuilderIntake>; internal: boolean; registration: RegistrationRow; subAccountSid: string | null },
  deps: {
    lock: TrustLock;
    create: (intake: BuilderIntake, friendlyName: string) => Promise<{ profileSid: string }>;
    finish: (profileSid: string) => Promise<{ linked: boolean; submitted: boolean; status?: TrustProductStatus | null }>;
    /** An update of this tenant's sms_registrations row. */
    write: Write;
  },
): Promise<TrustProfileOutcome> {
  if (o.internal) return { ok: false, kind: "refused", status: 409, error: TRUST_PROFILE_INTERNAL_SENTENCE };
  const reg = o.registration ?? {};
  const recorded = String(reg.customer_profile_sid ?? "").trim();
  if (!BU.test(recorded)) {
    const problems = validateIntake(o.intake, true);
    if (problems.length) return { ok: false, kind: "refused", status: 400, error: problems[0], problems };
  }

  const claimed = await deps.lock.claim();
  if (!claimed.ok) {
    return claimed.busy
      ? { ok: false, kind: "refused", status: 409, error: TRUST_PROFILE_BUSY_SENTENCE }
      : { ok: false, kind: "db", error: claimed.error };
  }
  try {
    if (BU.test(recorded)) {
      const f = await deps.finish(recorded);
      const status = f.status ?? null;
      if (status === "twilio-rejected") return { ok: false, kind: "refused", status: 409, error: TRUST_PROFILE_REJECTED_SENTENCE };
      return { ok: true, created: false, finished: f.linked || f.submitted, status };
    }
    if (o.subAccountSid && !reg.twilio_account_sid) {
      const w = await deps.write({ twilio_account_sid: o.subAccountSid });
      if (!w.ok) return { ok: false, kind: "db", error: w.error };
    }
    const intake = o.intake as BuilderIntake;
    let profileSid: string;
    try {
      ({ profileSid } = await deps.create(intake, `${o.clientId} — ${intake.legalBusinessName}`));
    } catch (e) {
      // Written down in a sub-account only (step 6).
      if (e instanceof PrimaryProfileLinkError && o.subAccountSid && BU.test(e.profileSid)) {
        const w = await deps.write({ customer_profile_sid: e.profileSid });
        return profileTwilioFail(e, w.ok);
      }
      throw e;
    }
    const ein = String(intake.ein ?? "").replace(/\D/g, "");
    const echo: Record<string, unknown> = { customer_profile_sid: profileSid };
    if (!reg.legal_business_name) echo.legal_business_name = intake.legalBusinessName;
    if (!reg.ein_last4 && ein) echo.ein_last4 = ein.slice(-4);
    if (!reg.rep_email_domain) echo.rep_email_domain = String(intake.repEmail ?? "").split("@")[1] ?? null;
    if (!reg.website_url) echo.website_url = intake.websiteUrl;
    const w = await deps.write(echo);
    if (!w.ok) return { ok: false, kind: "db", error: w.error };
    return { ok: true, created: true, finished: false };
  } catch (e) {
    if (e instanceof TrustHubError) return profileTwilioFail(e, false);
    throw e;
  } finally {
    try { await deps.lock.release(); } catch { /* the lock expires on its own */ }
  }
}

export const TRUST_PROFILE_BUSY_SENTENCE =
  "This business's registration is already being worked on. Give it a minute, then try again.";

function profileTwilioFail(e: TrustHubError, recorded: boolean): TrustProfileOutcome {
  const code = e.code ? ` (error ${e.code})` : "";
  let error: string;
  if (e instanceof PrimaryProfileLinkError) {
    // Refused (Twilio said no) or unanswered (no response, a 5xx, a 429): what to do next differs.
    const what = e.refused
      ? `Twilio made the business profile but refused to link it to Structure Studio's own profile${code}.`
      : "Twilio made the business profile but didn't answer while it was being linked to Structure Studio's own profile.";
    const wait = e.refused ? "" : " in a minute";
    error = recorded
      ? `${what} It is saved here: press it again${wait} to retry just the link.`
      : `${what} Nothing was saved: press it again${wait} to start over.`;
  } else {
    error = e.permanent
      ? `Twilio didn't accept the business details${code}. Check them and press it again.`
      : "Couldn't reach Twilio just now. Press it again in a minute.";
  }
  // Codes only: Twilio's bodies echo the EIN and the representative's details.
  return { ok: false, kind: "twilio", status: 502, code: e.code, detail: e.message, recorded, error };
}
