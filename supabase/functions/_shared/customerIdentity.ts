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
// ⚠️ …EXCEPT WHEN THE ADDRESS IS SHARED (review, 2026-09-15). An address filed beside MORE THAN
// ONE phone in this tenant answers to more than one customer, and its email half grants nothing.
// The first email channel had this rule (a number that answered to two addresses supplied no
// identity), and it went out with the email→phone resolution. Without it, whoever reads a shared
// inbox — a builder's office address typed onto walk-in customers' designs, a dealer who files
// quotes for several buyers, a household on two phones — logs in by email and sees, accepts,
// signs and PAYS every one of those customers' orders. Read-only on live that day: 5 such
// addresses on junior-barns (up to 3 phones each, 50 issued quotes), 1 on testtttttt (5 phones),
// 1 on abc-builder, which is SS mode, so accept/sign/pay were really exposed.
// What it costs: those customers must sign in with their phone, where the OTP proves the very
// number the design names. And anyone can file a design (save_design is anon) pairing your
// address with a stranger's number to switch YOUR email login off. That is a nuisance with a
// working fallback, never a leak, which is the right way round for this trade.
// The phone half has no such rule: a phone OTP proves the number on the design, the ownership
// model since migration 108.
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
 * ⚠️ NOT an ownership verdict on its own: it does not apply the shared-address rule, which
 * ownsDesign does. customer-designs uses it bare on purpose. It only saves and lists DRAFT codes
 * the caller's own designer already holds, and a short code already opens its design in the
 * public designer. Anything that shows a quote, or accepts, signs or pays, goes through ownsDesign.
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
 * What this tenant's designs say about the session's verified ADDRESS: whether it is shared, i.e.
 * filed beside more than one phone (the header's shared-address rule). Produced only by
 * loadAddressStanding (or addressStandingFrom in tests), so a caller cannot skip the read by
 * inventing one.
 */
export type AddressStanding = { readonly emailShared: boolean };

/** Designs read per page by loadAddressStanding. Under PostgREST's 1000-row cap, so a page never
 *  comes back silently short and ends the scan early. */
export const ADDRESS_SCAN_PAGE = 500;

/**
 * Does `emailLower` answer to more than one phone across these design rows ({status, contact})?
 *
 * Every status counts, inventory and drafts included. A builder's address on its own stock beside
 * its own number, and on a customer's design beside theirs, is exactly the staff address the rule
 * exists for, and over-counting only ever withholds. A phone counts once phoneKey reduces it to
 * 10+ digits, so "(816) 555-0100" and "18165550100" are one phone, and a blank or 7-digit scrap
 * is no counterpart. Emails compare through normalizeEmail and only as STRINGS (matchedIdentities'
 * rules), so the address that is shared is the address that would have matched.
 */
export function addressIsShared(emailLower: string, rows: Iterable<unknown>): boolean {
  const email = normalizeEmail(emailLower ?? "");
  if (!email) return false;
  const phones = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const c = (row as Record<string, unknown>).contact;
    if (!c || typeof c !== "object" || Array.isArray(c)) continue;
    const cc = c as Record<string, unknown>;
    if (typeof cc.email !== "string" || normalizeEmail(cc.email) !== email) continue;
    const phone = phoneKey(cc.phone);
    if (phone.length >= 10) phones.add(phone);
    if (phones.size > 1) return true;
  }
  return false;
}

/** The standing computed from rows already in hand. For tests. Production uses loadAddressStanding. */
export function addressStandingFrom(identity: VerifiedIdentity | null | undefined, rows: Iterable<unknown>): AddressStanding {
  const email = normalizeEmail(identity?.emailLower ?? "");
  return { emailShared: !!email && addressIsShared(email, rows) };
}

/**
 * Read the tenant's designs and settle the session's address standing. For a session with no
 * verified email this reads nothing: there is no email half to withhold.
 *
 * Tenant-wide, paged on the unique short_code, matched in code: the comparison is normalizeEmail +
 * phoneKey, which PostgREST cannot state, and a single unpaged read stops at PostgREST's row cap,
 * dropping exactly the older design that would have shown the address is shared (the unsafe
 * direction). Only status and contact come back. The largest tenant had 88 designs on 2026-09-15.
 *
 * `{standing: null, error}` on a failed read. Callers answer with their own dbFail and must NOT
 * fall back to an unshared standing.
 */
export async function loadAddressStanding(
  // deno-lint-ignore no-explicit-any
  admin: any,
  clientId: string,
  identity: VerifiedIdentity | null | undefined,
): Promise<{ standing: AddressStanding; error: null } | { standing: null; error: unknown }> {
  const email = normalizeEmail(identity?.emailLower ?? "");
  if (!email) return { standing: { emailShared: false }, error: null };
  const rows: unknown[] = [];
  for (let from = 0;; from += ADDRESS_SCAN_PAGE) {
    const { data, error } = await admin.from("designs")
      .select("status, contact")
      .eq("client_id", clientId)
      .order("short_code")
      .range(from, from + ADDRESS_SCAN_PAGE - 1);
    if (error) return { standing: null, error };
    const page = (data ?? []) as unknown[];
    rows.push(...page);
    // A shared answer cannot be undone by more rows, so stop reading.
    if (addressIsShared(email, rows)) return { standing: { emailShared: true }, error: null };
    if (page.length < ADDRESS_SCAN_PAGE) break;
  }
  return { standing: { emailShared: false }, error: null };
}

/**
 * True when the verified phone matches the design's contact phone, or the verified email matches
 * the design's contact email AND that address is not shared in this tenant (`standing`, from
 * loadAddressStanding). False for anything else, including a missing or malformed contact.
 * The comparison rules are matchedIdentities' — one implementation, so the list, the accept, the
 * signature and the payment cannot disagree about whose design it is.
 *
 * `standing` is required, not defaulted: an ownership check that forgot the shared-address rule is
 * the review finding this parameter exists to make impossible to write by accident.
 */
export function ownsDesign(
  identity: VerifiedIdentity | null | undefined,
  contact: unknown,
  standing: AddressStanding,
): boolean {
  return matchedIdentities(identity, contact)
    .some((id) => id.column === "phone_digits" || !standing.emailShared);
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
