/**
 * Customer-portal session tokens over the `customer_sessions` table (migration 108).
 *
 * THE DESIGN RULE: the token itself is NEVER stored. `mintSession` returns the raw
 * base64url token exactly once and persists only its SHA-256 hex — the hash IS the
 * stored credential, so a leaked database row (or backup, or log line carrying the row)
 * exposes no usable tokens. Lookups re-hash the presented token and match on
 * `token_hash`; nothing secret is ever read back out of the table.
 *
 * Failure polarity, same posture as emailSend.ts: `checkSession` and `revokeSession`
 * NEVER throw — an identity check that can crash a handler turns a database blip into a
 * 500 for a customer holding a perfectly good session, and a dropped revoke still dies
 * at the TTL. `mintSession` is the one that throws on a failed write, deliberately:
 * returning a token whose row never landed would mint a credential that fails every
 * later check with no error anywhere.
 *
 * `customer_sessions` is service-role only; `admin` is always the service-role client.
 *
 * ── TWO WAYS TO BE SOMEONE (migration 230, 2026-09-15) ────────────────────────────────────
 * A session proves a PHONE (Twilio Verify text), an EMAIL ADDRESS (our own emailed code), or
 * both. `phone_digits` and `email_lower` are each null unless that identity was proven by a
 * code sent to it; the table's check refuses a row carrying neither. Ahsan, 2026-09-15 (expo
 * plan, decision 3): text AND email login codes before the expo.
 *
 * ⚠️ AN EMAIL SESSION IS KEYED ON THE ADDRESS AND NOTHING ELSE. The first email channel
 * (2026-08-30) proved an address and then minted the session on a phone it read off a design's
 * contact blob, which anyone can write — so a stranger could pair their own inbox with a victim's
 * number. It was switched off on 2026-09-06 for exactly that. Nothing in this module ever turns
 * one identity into the other; the only way a session gains a second one is `addIdentity`, and
 * that is called only after a code sent to that second identity was proven.
 *
 * ⚠️ DEPLOY ORDER. checkSession selects `email_lower`. Against a database without migration 230
 * that select errors, checkSession answers null, and EVERY customer is told their session
 * expired. Apply 230 before deploying any importer (customer-auth, customer-quotes,
 * customer-accept, customer-pay).
 */

// deno-lint-ignore-file no-explicit-any

/** Sessions live 30 days from mint. `expires_at` is stored absolute (the qboToken
 *  lesson: storing durations is a clock bug waiting to happen on every read). */
export const SESSION_TTL_DAYS = 30;

/** 32 random bytes base64url-encode to exactly 43 chars, so anything shorter cannot be
 *  a token we minted — reject it before spending a hash or a database round-trip. */
const MIN_TOKEN_CHARS = 43;
/** And anything wildly longer is garbage too; the cap keeps a hostile multi-megabyte
 *  "token" from buying a SHA-256 of itself. */
const MAX_TOKEN_CHARS = 128;

/** Who a session proved to be. At least one of the two is non-null (the table's check). */
export type CustomerIdentity = {
  clientId: string;
  /** The 10 digits after "+1" of a phone that answered a texted code, or null. */
  phoneDigits: string | null;
  /** A lower-cased, trimmed address that answered an emailed code (emailOtp.normalizeEmail), or null. */
  emailLower: string | null;
  name: string | null;
};

/** The identity a verify step just proved — exactly one of the two, in practice. */
export type ProvenIdentity = { phoneDigits?: string | null; emailLower?: string | null };

/** A column value as the identity: blank and null both mean "not proven". */
function idValue(v: unknown): string | null {
  const s = v == null ? "" : String(v).trim();
  return s ? s : null;
}

/**
 * The identity as the customer's browser may see it: `{phone?, email?}`, each key present only
 * when proven. Their OWN verified keys — never anything read off a design — so the
 * migration-048 rule holds (a leaked token lists this identity's quotes; naming it adds nothing).
 */
export function identityForClient(identity: CustomerIdentity): { phone?: string; email?: string } {
  return {
    ...(identity.phoneDigits ? { phone: identity.phoneDigits } : {}),
    ...(identity.emailLower ? { email: identity.emailLower } : {}),
  };
}

/** SHA-256 as lowercase hex. Exported so tests (and callers correlating a token to its
 *  row) can compute the stored form without re-implementing it. */
export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** RFC 4648 base64url, no padding. */
function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Mint a session for a verified customer and return the RAW token — the only moment it
 * exists in plaintext anywhere. The row stores its hash; the caller hands the token to
 * the customer and forgets it.
 *
 * Throws if the row cannot be written: a token with no row behind it would pass nothing
 * and fail silently forever, which is worse than an honest error at mint time. Also throws,
 * before any write, when `who` names no identity — a session for nobody is a bug in the caller,
 * and the table would refuse it anyway.
 */
export async function mintSession(
  admin: any,
  clientId: string,
  who: ProvenIdentity,
  name: string | null,
): Promise<string> {
  const phoneDigits = idValue(who?.phoneDigits);
  const emailLower = idValue(who?.emailLower);
  if (!phoneDigits && !emailLower) {
    throw new Error("customer session needs a verified phone or email");
  }

  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = base64url(bytes);

  const { error } = await admin.from("customer_sessions").insert({
    client_id: clientId,
    phone_digits: phoneDigits,
    email_lower: emailLower,
    name,
    token_hash: await sha256Hex(token),
    expires_at: new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString(),
  });
  if (error) throw new Error(`customer session could not be stored: ${error.message}`);
  return token;
}

/**
 * Resolve a presented token to its identity, or null. Never throws.
 *
 * Cheap rejections first: a non-string or wrong-length value is null WITHOUT any
 * database call — every request carries this check, and most garbage (absent cookies,
 * truncated values, probes) dies here for free. A live hit touches `last_seen_at`
 * fire-and-forget: the touch is bookkeeping, and a failed UPDATE must not turn a valid
 * session into a rejected request.
 */
export async function checkSession(admin: any, token: unknown): Promise<CustomerIdentity | null> {
  try {
    if (typeof token !== "string") return null;
    if (token.length < MIN_TOKEN_CHARS || token.length > MAX_TOKEN_CHARS) return null;

    const tokenHash = await sha256Hex(token);
    const { data, error } = await admin.from("customer_sessions")
      .select("client_id, phone_digits, email_lower, name")
      .eq("token_hash", tokenHash)
      .is("revoked_at", null)
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();
    if (error || !data) return null;
    const phoneDigits = idValue(data.phone_digits);
    const emailLower = idValue(data.email_lower);
    // A row that proves nothing is no identity. The table's check makes this unreachable; the
    // guard keeps String(null) from ever becoming the phone "null" if that check is lost.
    if (!phoneDigits && !emailLower) return null;

    // Fire-and-forget: the builder is a thenable, so Promise.resolve() starts it, and the
    // no-op catch keeps a rejection from becoming an unhandled-rejection crash. Its
    // outcome is deliberately not part of the verdict.
    try {
      Promise.resolve(
        admin.from("customer_sessions")
          .update({ last_seen_at: new Date().toISOString() })
          .eq("token_hash", tokenHash),
      ).catch(() => {});
    } catch { /* a throwing builder must not cost the caller a valid session */ }

    return {
      clientId: String(data.client_id),
      phoneDigits,
      emailLower,
      name: data.name == null ? null : String(data.name),
    };
  } catch {
    return null;
  }
}

/**
 * Add a second proven identity to an existing session — the same person by phone AND email.
 * Returns the merged identity (the caller hands back the SAME token), or null, in which case the
 * caller mints a fresh session carrying only what was just proven. Never throws.
 *
 * Call it ONLY after a code sent to `who` was verified. Presenting a token proves the caller
 * holds that session; verifying the code proves they control the new identity. Together they are
 * one person, which is what lets one login open quotes filed under either.
 *
 * Null (→ a fresh session, the safe direction) when:
 *   * the token is garbage, unknown, revoked or expired
 *   * the session belongs to another tenant — an identity never crosses builders
 *   * the session already holds a DIFFERENT value for that identity. Proving phone B on a
 *     session keyed to phone A is someone else on the same device, not a second key for A.
 *   * the fill lost a race (another request filled the column first)
 *
 * A session that already holds exactly this value returns unchanged, with no write.
 * The name is filled only where the session had none; a name is a label, never an identity.
 */
export async function addIdentity(
  admin: any,
  token: unknown,
  clientId: string,
  who: ProvenIdentity,
  name: string | null = null,
): Promise<CustomerIdentity | null> {
  try {
    if (typeof token !== "string") return null;
    if (token.length < MIN_TOKEN_CHARS || token.length > MAX_TOKEN_CHARS) return null;
    const phone = idValue(who?.phoneDigits);
    const email = idValue(who?.emailLower);
    // Exactly one identity per call: that is what one verified code proves.
    if (!phone === !email) return null;
    const col = phone ? "phone_digits" : "email_lower";
    const value = (phone ?? email) as string;

    const tokenHash = await sha256Hex(token);
    const { data, error } = await admin.from("customer_sessions")
      .select("client_id, phone_digits, email_lower, name")
      .eq("token_hash", tokenHash)
      .is("revoked_at", null)
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();
    if (error || !data) return null;
    if (String(data.client_id) !== clientId) return null;

    const current: CustomerIdentity = {
      clientId,
      phoneDigits: idValue(data.phone_digits),
      emailLower: idValue(data.email_lower),
      name: data.name == null ? null : String(data.name),
    };
    if (!current.phoneDigits && !current.emailLower) return null;
    const held = col === "phone_digits" ? current.phoneDigits : current.emailLower;
    if (held === value) return current;
    if (held !== null) return null;

    const patch: Record<string, unknown> = { [col]: value, last_seen_at: new Date().toISOString() };
    const fillName = current.name == null && name ? name : null;
    if (fillName) patch.name = fillName;
    // Matched on the column still being null, so two racing upgrades cannot both land and the
    // second cannot overwrite the first.
    const { data: updated, error: upErr } = await admin.from("customer_sessions")
      .update(patch)
      .eq("token_hash", tokenHash)
      .is(col, null)
      .select("client_id");
    if (upErr || !Array.isArray(updated) || updated.length === 0) return null;

    return {
      ...current,
      ...(col === "phone_digits" ? { phoneDigits: value } : { emailLower: value }),
      name: fillName ?? current.name,
    };
  } catch {
    return null;
  }
}

/**
 * Revoke the session behind a token (logout). Never throws, and best-effort on purpose:
 * a revoke the database dropped leaves a session that still dies at its TTL, whereas a
 * logout endpoint that 500s teaches customers that logging out is broken.
 */
export async function revokeSession(admin: any, token: unknown): Promise<void> {
  try {
    if (typeof token !== "string") return;
    if (token.length < MIN_TOKEN_CHARS || token.length > MAX_TOKEN_CHARS) return;
    await admin.from("customer_sessions")
      .update({ revoked_at: new Date().toISOString() })
      .eq("token_hash", await sha256Hex(token));
  } catch { /* the TTL is the backstop */ }
}
