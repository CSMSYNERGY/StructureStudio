// _shared/placeholderRecipient.ts — is this customer email a placeholder nobody can receive?
//
// WHY THIS EXISTS. A design created for a demo or a test often carries a made-up customer
// address on a reserved domain (RFC 2606 / RFC 6761: example.com/.net/.org and the .test,
// .example, .invalid and .localhost TLDs). The email provider rejects those, and the invoice
// email retry then turned that rejection into a 502 fault row saying only "(failed)".
//
// Deciding it HERE, from the address itself, is deliberate. The provider's 422 is a
// request-shape error ("invalid or missing fields"), not a recipient verdict, so reading it
// as "the address was rejected" would also label a real code fault (a bad tag or header) as
// a customer typo and file it as info. A reserved domain is a fact we can check before any
// send, and it can never be a real inbox.
//
// Pure: no network, no database, no env.
//
// ⚠️ Importers, ALL of which must be redeployed together when this changes (_shared
//    bundles PER function):
//      portal-settings/index.ts

/** The second-level domains reserved for documentation (RFC 2606 §3). */
const RESERVED_DOMAINS = ["example.com", "example.net", "example.org"];

/** The top-level domains reserved so they never resolve (RFC 2606 §2, RFC 6761). */
const RESERVED_TLDS = ["test", "example", "invalid", "localhost"];

/**
 * True when `email`'s domain is a reserved placeholder: example.com, example.net or
 * example.org (or any subdomain of one), or any domain under the .test, .example, .invalid
 * or .localhost TLDs. Case and surrounding whitespace are ignored, as is a trailing root dot.
 *
 * Anything without an `@` and a domain is NOT a placeholder by this test — whether it is an
 * email address at all is the caller's isEmail check, which runs first.
 */
export function isPlaceholderRecipient(email: unknown): boolean {
  if (typeof email !== "string") return false;
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at < 0) return false;
  const domain = trimmed.slice(at + 1).replace(/\.+$/, "");
  if (!domain) return false;
  if (RESERVED_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) return true;
  const tld = domain.slice(domain.lastIndexOf(".") + 1);
  return RESERVED_TLDS.includes(tld);
}
