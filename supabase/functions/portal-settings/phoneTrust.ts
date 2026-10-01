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

import {
  TrustHubError, trustProductStatus, VOICE_INTEGRITY_INFO_REQUIRED, voiceTrustFriendlyName,
  type TrustProductStatus, type VoiceIntegrityInfo, type VoiceTrustKind, type VoiceTrustResult, type VoiceTrustSetup,
} from "../_shared/twilioTrustHub.ts";

/** The number row's caller-ID columns (migration 255), and the id they are keyed by. */
export const TRUST_COLUMNS =
  "id, shaken_trust_product_sid, shaken_status, voice_integrity_trust_product_sid, voice_integrity_status, caller_id_checked_at";

export type TrustRow = {
  id?: string;
  shaken_trust_product_sid?: string | null;
  shaken_status?: string | null;
  voice_integrity_trust_product_sid?: string | null;
  voice_integrity_status?: string | null;
  caller_id_checked_at?: string | null;
};

/** Where each product lives on the row. */
type SidCol = "shaken_trust_product_sid" | "voice_integrity_trust_product_sid";
type StatusCol = "shaken_status" | "voice_integrity_status";
export const TRUST_COLS: Record<VoiceTrustKind, { sid: SidCol; status: StatusCol }> = {
  shaken_stir: { sid: "shaken_trust_product_sid", status: "shaken_status" },
  voice_integrity: { sid: "voice_integrity_trust_product_sid", status: "voice_integrity_status" },
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

/** Which product the request is about: "shaken_stir" (the default, plan item a) or
 *  "voice_integrity". Anything else is refused rather than guessed. */
export function parseTrustProduct(raw: unknown): VoiceTrustKind | null {
  if (raw === undefined || raw === null || raw === "") return "shaken_stir";
  return raw === "shaken_stir" || raw === "voice_integrity" ? raw : null;
}

const BU = /^BU[0-9a-f]{32}$/i;

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
}): { ok: true; profileSid: string; which: "secondary" | "primary" } | { ok: false; error: string } {
  const sec = String(o.secondaryProfileSid ?? "").trim();
  const pri = String(o.primaryProfileSid ?? "").trim();
  if (o.internal && o.numberOnPrimary && BU.test(pri)) return { ok: true, profileSid: pri, which: "primary" };
  if (BU.test(sec)) return { ok: true, profileSid: sec, which: "secondary" };
  if (o.internal) {
    if (BU.test(pri)) return { ok: true, profileSid: pri, which: "primary" };
    return { ok: false, error: "This account has no business profile at Twilio, and the platform's own profile isn't configured on this server." };
  }
  return {
    ok: false,
    error: "Caller ID registration uses the business details from the Text Messaging registration, and this account hasn't submitted them yet. Submit them on the Text Messaging tab first.",
  };
}

export type TrustProfileChoice =
  | { ok: true; profileSid: string; which: "secondary" | "primary" }
  | { ok: false; kind: "refused"; status: 409; error: string }
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
  return prof.ok ? prof : { ok: false, kind: "refused", status: 409, error: prof.error };
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
  checkedAt: string | null;
};

/** What the Phone tab is told. `available: false` = migration 255 is not applied yet. No SIDs. */
export function callerIdView(row: TrustRow | null, available = true): CallerIdView {
  const r = row ?? {};
  return {
    available,
    shakenStir: { registered: !!r.shaken_trust_product_sid, status: trustProductStatus(r.shaken_status) },
    voiceIntegrity: { registered: !!r.voice_integrity_trust_product_sid, status: trustProductStatus(r.voice_integrity_status) },
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
      onTrustProduct: async (sid, status) => {
        const w = await deps.write({ [cols.sid]: sid, [cols.status]: status, caller_id_checked_at: now() });
        if (!w.ok) throw new TrustWriteError(w.error);
      },
    });
    const w = await deps.write({ [cols.sid]: result.trustProductSid, [cols.status]: result.status, caller_id_checked_at: now() });
    if (!w.ok) return { ok: false, kind: "db", error: w.error };
    return { ok: true, result };
  } catch (e) {
    if (e instanceof TrustWriteError) return { ok: false, kind: "db", error: e.inner };
    if (e instanceof TrustHubError) {
      if (e.message === VOICE_INTEGRITY_INFO_REQUIRED) {
        return { ok: false, kind: "refused", status: 400, error: "Answer the Voice Integrity questions first: what the business uses calls for, how many people work there, and about how many calls it makes a day." };
      }
      return twilioFail(e);
    }
    throw e;
  }
}

export type TrustStatusOutcome =
  | { ok: true; view: CallerIdView; errorCodes: { shakenStir: number[]; voiceIntegrity: number[] }; changed: boolean }
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
  const errorCodes = { shakenStir: [] as number[], voiceIntegrity: [] as number[] };
  const next: TrustRow = { ...row };
  try {
    for (const kind of ["shaken_stir", "voice_integrity"] as const) {
      const cols = TRUST_COLS[kind];
      const sid = String(row[cols.sid] ?? "");
      if (!BU.test(sid)) continue;
      try {
        const t = await deps.fetchTrustProduct(sid);
        patch[cols.status] = t.status;
        next[cols.status] = t.status;
        errorCodes[kind === "shaken_stir" ? "shakenStir" : "voiceIntegrity"] = t.errorCodes;
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
