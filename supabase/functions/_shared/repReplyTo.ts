// _shared/repReplyTo.ts — whose inbox a customer's reply is copied to.
//
// WHY THIS EXISTS. Carolyn, 2026-09-01: "the first thing that we need to do is have a reply to in
// here." Then 2026-09-04 @35:06: "every user should be able to go in and say, when somebody replies
// to an email, send it here. But that should be in their profile." Since 2026-09-06 sendTenantEmail
// puts BOTH the CRM routing address and the caller's replyTo in Reply-To (combineReplyTo), but only
// crm_send_email ever passed a replyTo. Every quote, invoice, change order and acceptance passed
// none, so a customer's reply to their quote reached the customer's record and never anybody's
// inbox — while My Profile told every rep it would (the 09-15 audit, COM-04). This module answers
// "whose inbox?" for every sender, by one rule, so the senders cannot drift apart.
//
// THE RULE.
//   • An email a STAFF MEMBER set off carries that person's address: a conversation email, a quote
//     re-send or re-price, an invoice send, re-issue or retry, a change order, a rep's submit in the
//     designer.
//   • An email the CUSTOMER set off (a shopper submitting their own design, the three acceptance
//     confirmations) carries the address of the rep the customer is assigned to:
//     crm_contacts.owner_user_id, reached from the design's contact_id. So does a send by someone
//     who isn't a person of this tenant at all (view-as, below, or a login with no membership
//     here). A MEMBER who sent it but has no usable address (a text-message login with no email,
//     or an address the header check refuses) gets no copy: a reply never goes to a colleague
//     for an email that colleague didn't write.
//   • The assigned rep only when the email goes to THAT customer: the recipient must be the
//     contact's own email (crm_contacts.email). A design is linked to a contact by phone first
//     (crm_ensure_contact), and the address on an anonymous submit is whatever the shopper typed,
//     so without this a stranger who typed a known customer's phone number and their own email
//     would learn which rep owns that customer, and that rep's address.
//   • Nobody to name: nothing is added, and the reply carries the routing address alone, which is
//     exactly how every document email behaved before this.
//   • A person's address is their own choice in My Profile (client_users.prefs.replyToEmail, read
//     on THIS tenant), else the email they sign in with. crm_send_email's order since 09-06.
//
// NEVER CSM SYNERGY ON A BUILDER'S PAPERWORK. A person counts only with a client_users row on
// THIS tenant, and never in view-as. client_users.user_id is that table's primary key, so a login
// belongs to one tenant at most, and an operator's one membership is our own account: the row
// check alone keeps every operator off every customer's email. On top of it, an app_operators
// login is refused on any tenant that is not ours (client_settings.internal_account, migration
// 169), so a membership elsewhere one day still can't put a CSM Synergy address on a builder's
// quote. On OUR OWN account they are the builder: Carolyn's conversation emails from it have
// carried her address since 09-06, and refusing operators there would quietly take that away.
//
// HEADER-SAFE. Whatever the value came from (a saved preference, an auth record, a row written by
// something else), it goes into a mail header, so it is checked here every time: a plain
// local@domain.tld of ASCII letters, digits and the usual address punctuation, at most 320
// characters. No spaces or line breaks (header injection), no commas or semicolons (a second
// address), no <>, quotes, parentheses or colons (display names, comments, groups). Anything else
// is dropped, never repaired, because a malformed Reply-To can make the provider refuse the whole
// email, and a refusal is permanent: the quote would never arrive. save_prefs and the My Profile
// box apply the same REPLY_ADDRESS_RE, so a person is told at the box rather than at the send.
//
// NEVER THROWS, AND NEVER BLOCKS A SEND. Every failure answers null and the email goes with the
// routing address only. A failed read is not "nobody to name", so it never falls through to the
// assigned rep either: the copy goes to the right person or to no one. `onError` hears why (no
// addresses in it), so the caller can log it.
//
// NO FORWARDING. The rep's copy arrives because the customer's own mail program sends the reply to
// both addresses. email-inbound must never send mail (its header says so); nothing here changes that.
//
// No network beyond the client handed in, no env, no jsr:/npm: imports (the _shared test rule).
//
// ⚠️ Importers, ALL of which must be redeployed together when this changes (_shared
//    bundles PER function):
//      portal-settings/index.ts
//      submit-estimate/index.ts
//      customer-accept/index.ts

import { isInternalTenant } from "./internalTenant.ts";

// deno-lint-ignore no-explicit-any
type Admin = any;

/** The longest address kept: RFC 5321's limit, and the cap save_prefs and beta_email use. */
export const REPLY_ADDRESS_MAX = 320;

/**
 * A reply address that is safe in a mail header: a dot-atom local part (RFC 5322, no quoted
 * forms), then a domain of letter/digit/hyphen labels with at least one dot. ASCII only: a
 * non-ASCII address needs the provider's SMTPUTF8 support, which nobody here has confirmed.
 *
 * ⚠️ portal/08-integrations.jsx carries this same literal for the My Profile box, and
 * repReplyToSenders.test.ts fails if the two differ. Change both together.
 */
export const REPLY_ADDRESS_RE =
  /^[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/** The address, trimmed, when it is safe to advertise; null otherwise. Never repairs one. */
export function cleanReplyAddress(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const addr = raw.trim();
  if (!addr || addr.length > REPLY_ADDRESS_MAX) return null;
  return REPLY_ADDRESS_RE.test(addr) ? addr : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);
const why = (e: unknown) => String((e as { message?: unknown } | null)?.message ?? e ?? "unknown").slice(0, 200);

export type ReplyLookupError = (why: string) => void;

/**
 * This person's reply address on this tenant, or null when they are not someone a customer of
 * this tenant should be pointed at (see the header): not a member here, in view-as
 * (`operator: true`), or a CSM Synergy operator on a tenant that is not ours. Otherwise their
 * own saved address if it is usable, else their sign-in email if THAT is usable, else null.
 */
export async function personReplyAddress(
  admin: Admin,
  clientId: string,
  userId: string | null | undefined,
  opts: { operator?: boolean; onError?: ReplyLookupError } = {},
): Promise<string | null> {
  return (await lookupPerson(admin, clientId, userId, opts)).address;
}

/**
 * personReplyAddress plus the one thing repReplyTo also needs: whether this is someone we name
 * here at all (`named`). That tells a member with no usable address ("named, nothing to put")
 * apart from a stranger to this tenant ("not someone we name"). Only the second may fall
 * through to the customer's assigned rep.
 */
async function lookupPerson(
  admin: Admin,
  clientId: string,
  userId: string | null | undefined,
  opts: { operator?: boolean; onError?: ReplyLookupError },
): Promise<{ named: boolean; address: string | null }> {
  const nobody = { named: false, address: null };
  const fail = (what: string, e: unknown) => {
    try { opts.onError?.(`${what}: ${why(e)}`); } catch (_) { /* a logger must not cost the email */ }
    return nobody;
  };
  try {
    // View-as first, before any read: the signed-in person is CSM Synergy staff writing for the
    // builder (the signature rule in crm_send_email, for the same reason).
    if (opts.operator) return nobody;
    if (!clientId || !isUuid(userId)) return nobody;
    const [mem, op] = await Promise.all([
      // Keyed on the tenant as well as the person. The read this replaces (crm_send_email,
      // limit(1) on user_id alone) answered with whatever row it found, on whichever tenant.
      admin.from("client_users").select("prefs").eq("user_id", userId).eq("client_id", clientId).limit(1),
      admin.from("app_operators").select("user_id").eq("user_id", userId).maybeSingle(),
    ]);
    if (mem?.error) return fail("client_users read failed", mem.error);
    if (op?.error) return fail("app_operators read failed", op.error);
    const row = Array.isArray(mem?.data) ? mem.data[0] : null;
    // Not a member of this tenant: a departed rep, or a platform operator viewing it. Nobody.
    if (!row) return nobody;
    // A CSM Synergy operator is named only on our own account. isInternalTenant throws on a
    // failed read, which lands in the catch below as "nobody": we could not tell, so we don't.
    if (op?.data && !(await isInternalTenant(admin, clientId))) return nobody;

    const own = cleanReplyAddress((row.prefs as Record<string, unknown> | null)?.replyToEmail);
    if (own) return { named: true, address: own };
    const { data: u, error: uErr } = await admin.auth.admin.getUserById(userId);
    if (uErr) return fail("auth user read failed", uErr);
    // A text-message login has no email at all; that is "nothing to put", not a fault.
    return { named: true, address: cleanReplyAddress(u?.user?.email) };
  } catch (e) {
    return fail("reply address lookup failed", e);
  }
}

/** Two addresses are the same one when they match trimmed and ignoring case. */
const sameAddress = (a: unknown, b: unknown) =>
  typeof a === "string" && typeof b === "string" && a.trim() !== "" && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The reply address of the rep this customer is assigned to: crm_contacts.owner_user_id, for the
 * contact named directly or for the design's contact_id (a merge re-points designs, migration
 * 192, so the design always names the surviving contact). Null when nobody is assigned, or the
 * person assigned is no longer someone personReplyAddress will name (left the company, say).
 *
 * `recipient` is the address the email is going to, and it is required: the rep is named only
 * when it is that contact's own email (crm_contacts.email, case and spaces aside). Not a second
 * person's address on the record (crm_contact_people): crm_ensure_contact files a NEW email typed
 * beside a known phone number there, from an anonymous design, so a match on it proves nothing
 * about who will read the email. No recipient, or a different one: null, the routing address alone.
 */
export async function ownerReplyAddress(
  admin: Admin,
  clientId: string,
  ref: { shortCode?: string | null; contactId?: string | null; recipient?: string | null },
  opts: { onError?: ReplyLookupError } = {},
): Promise<string | null> {
  const fail = (what: string, e: unknown) => {
    try { opts.onError?.(`${what}: ${why(e)}`); } catch (_) { /* a logger must not cost the email */ }
    return null;
  };
  try {
    if (!clientId) return null;
    if (typeof ref.recipient !== "string" || !ref.recipient.trim()) return null;
    let contactId = isUuid(ref.contactId) ? ref.contactId : null;
    const shortCode = typeof ref.shortCode === "string" ? ref.shortCode.trim() : "";
    if (!contactId && shortCode) {
      const { data: d, error: dErr } = await admin.from("designs")
        .select("contact_id").eq("client_id", clientId).eq("short_code", shortCode).maybeSingle();
      if (dErr) return fail("designs read failed", dErr);
      contactId = isUuid(d?.contact_id) ? d.contact_id : null;
    }
    if (!contactId) return null;
    const { data: c, error: cErr } = await admin.from("crm_contacts")
      .select("owner_user_id, email").eq("client_id", clientId).eq("id", contactId).maybeSingle();
    if (cErr) return fail("crm_contacts read failed", cErr);
    if (!isUuid(c?.owner_user_id)) return null;
    // The email is going to somebody other than this customer (see above): no rep for them.
    if (!sameAddress(c?.email, ref.recipient)) return null;
    return await personReplyAddress(admin, clientId, c.owner_user_id, { onError: opts.onError });
  } catch (e) {
    return fail("owner reply address lookup failed", e);
  }
}

/**
 * THE ONE CALL every sender makes: the staff sender's address when there is a sender who may be
 * named, otherwise the customer's assigned rep. Pass `senderUserId` only for a send a signed-in
 * person set off (the verified session's id, never anything from the request body), `operator`
 * when that session is view-as, the design's short code (or the contact's id) for the rep, and
 * `recipient`, the address the email is going to: the rep is named only for their customer's own
 * address (ownerReplyAddress). Put the answer in TenantMail.replyTo; null means "add nothing".
 */
export async function repReplyTo(
  admin: Admin,
  clientId: string,
  who: {
    senderUserId?: string | null;
    operator?: boolean;
    shortCode?: string | null;
    contactId?: string | null;
    recipient?: string | null;
    onError?: ReplyLookupError;
  },
): Promise<string | null> {
  let failed = false;
  const onError: ReplyLookupError = (w) => {
    failed = true;
    try { who.onError?.(w); } catch (_) { /* a logger must not cost the email */ }
  };
  if (who.senderUserId) {
    const sender = await lookupPerson(admin, clientId, who.senderUserId, { operator: who.operator, onError });
    // A sender we could not READ is not a sender with nobody to name: no copy, rather than a copy
    // to a colleague the person who wrote the email did not choose. For the same reason a member
    // of this tenant gets their own address or no copy at all; only someone we don't name here
    // (view-as, no membership) falls through to the customer's rep.
    if (failed) return null;
    if (sender.named) return sender.address;
  }
  return await ownerReplyAddress(
    admin, clientId,
    { shortCode: who.shortCode, contactId: who.contactId, recipient: who.recipient },
    { onError: who.onError },
  );
}
