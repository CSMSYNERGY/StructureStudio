// _shared/customerIdentity.ts — does this verified customer own this design?
//
// WHY THIS IS ITS OWN MODULE (2026-09-15, migration 230). Customer login grows a second proven
// identity: an email address, beside the phone. Every customer write and read authorises on one
// question — "is this design theirs?" — and until today each function answered it inline as
// `phoneKey(contact.phone) === phoneKey(session phone)`. With two identities that compare is
// no longer one line, and three hand-kept copies of the check that decides whether a stranger
// can read, sign or PAY someone else's invoice is how one of them drifts. (phoneKey.ts moved out
// of those functions for the same reason.)
//
// ⚠️ THE RULE: a verified phone matches the design's phone, OR a verified email matches the
// design's email. Like with like, and nothing else. NEVER resolve an email to a phone (or a
// phone to an email) through a design. `designs.contact` is written by save_design, which anon
// may call and which stores the blob verbatim, so the pairing of an address with a number on a
// design is a CLAIM by whoever filed it. The first email channel (2026-08-30) proved an address,
// looked up a phone beside it on a design, and minted the session on that phone — pair your own
// inbox with a victim's number, verify your own code, and the session was theirs. It was turned
// off on 2026-09-06 for exactly that, and this function is shaped so that bridge cannot be
// rebuilt by accident: it never looks at one identity to decide the other.
//
// What the rule still allows, deliberately: a design whose contact carries YOUR verified email
// is listed for you even if someone else typed it. That shows you a design someone attributed to
// you. It never shows anyone else a design of yours, which is the direction that leaks.
//
// ⚠️ Duplication ledger — importers, ALL of which must be redeployed together when this changes
//    (_shared bundles PER function):
//      customer-quotes/index.ts
//      customer-accept/index.ts
//      customer-pay/index.ts
//      customer-designs/handler.ts (migration 231)

import { phoneKey } from "./phoneKey.ts";
import { normalizeEmail } from "./emailOtp.ts";

/** The verified half of a session (customerSession.CustomerIdentity satisfies it). */
export type VerifiedIdentity = {
  phoneDigits: string | null;
  emailLower: string | null;
};

/** One proven identity as the column that stores it (customer_sessions, design_acceptances and
 *  customer_design_links all use these two names) and its normalised value. */
export type IdentityColumn =
  | { column: "phone_digits"; value: string }
  | { column: "email_lower"; value: string };

/**
 * Each identity the session proved, normalised the way ownsDesign compares it: the phone through
 * phoneKey, the address through normalizeEmail. Blank identities are absent. [] for no identity.
 */
export function provenIdentityColumns(identity: VerifiedIdentity | null | undefined): IdentityColumn[] {
  if (!identity) return [];
  const out: IdentityColumn[] = [];
  const phone = phoneKey(identity.phoneDigits ?? "");
  if (phone) out.push({ column: "phone_digits", value: phone });
  const email = normalizeEmail(identity.emailLower ?? "");
  if (email) out.push({ column: "email_lower", value: email });
  return out;
}

/**
 * The proven identities that the design's contact actually NAMES — the phone half and the email
 * half of ownsDesign, reported separately. [] means the design is not theirs.
 *
 * Phone: both sides through phoneKey, exactly as the inline checks ownsDesign replaced did, so an
 * 11-digit stored "1816…" still matches the 10-digit session and no existing match changes.
 * Email: both sides through normalizeEmail (trim + lower-case only — no +tag or dot folding, see
 * emailOtp.ts), and only when the contact's email is a STRING; a crafted array must not
 * stringify its way into a match.
 *
 * Blank never matches blank: an identity with no phone cannot own a design with no phone.
 *
 * Separately because customer-designs (migration 231) records a saved design under the identity
 * that matched, not under whatever else the session holds: a session that proved phone P and
 * email E, saving a design whose contact names only P, must not make that design appear for a
 * later email-only login as E — ownsDesign would refuse that login, so the list must too.
 */
export function matchedIdentities(identity: VerifiedIdentity | null | undefined, contact: unknown): IdentityColumn[] {
  if (!identity || !contact || typeof contact !== "object" || Array.isArray(contact)) return [];
  const c = contact as Record<string, unknown>;
  return provenIdentityColumns(identity).filter((id) => {
    if (id.column === "phone_digits") {
      const theirPhone = phoneKey(c.phone);
      return !!theirPhone && theirPhone === id.value;
    }
    if (typeof c.email !== "string") return false;
    const theirEmail = normalizeEmail(c.email);
    return !!theirEmail && theirEmail === id.value;
  });
}

/**
 * True when the verified phone matches the design's contact phone, or the verified email matches
 * the design's contact email. False for anything else, including a missing or malformed contact.
 * The comparison rules are matchedIdentities' — one implementation, so the list, the accept, the
 * signature and the payment cannot disagree about whose design it is.
 */
export function ownsDesign(identity: VerifiedIdentity | null | undefined, contact: unknown): boolean {
  return matchedIdentities(identity, contact).length > 0;
}

/**
 * The identity columns every `design_acceptances` insert made on a customer's behalf writes —
 * BOTH, each null unless that identity was proven. The row is legal evidence of who agreed, so it
 * records the session's verified keys as they are, never a value read off the design. One helper
 * so no insert can quietly keep writing only the phone.
 */
export function acceptanceIdentityColumns(identity: VerifiedIdentity): {
  phone_digits: string | null;
  email_lower: string | null;
} {
  return {
    phone_digits: identity.phoneDigits || null,
    email_lower: identity.emailLower || null,
  };
}
