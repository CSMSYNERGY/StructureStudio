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

export type CustomerIdentity = {
  clientId: string;
  phoneDigits: string;
  name: string | null;
};

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
 * and fail silently forever, which is worse than an honest error at mint time.
 */
export async function mintSession(
  admin: any,
  clientId: string,
  phoneDigits: string,
  name: string | null,
): Promise<string> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = base64url(bytes);

  const { error } = await admin.from("customer_sessions").insert({
    client_id: clientId,
    phone_digits: phoneDigits,
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
      .select("client_id, phone_digits, name")
      .eq("token_hash", tokenHash)
      .is("revoked_at", null)
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();
    if (error || !data) return null;

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
      phoneDigits: String(data.phone_digits),
      name: data.name == null ? null : String(data.name),
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
