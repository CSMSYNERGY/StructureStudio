// Checks a Supabase access token HERE, against the project's published signing keys, instead of
// asking GoTrue over the network with auth.getUser().
//
// WHY: getUser() is a round trip to the auth server on every call, and it is the slowest and
// least predictable thing in the portal's preamble. Measured 2026-10-01 with portal-settings'
// Server-Timing, the function running next to the database: the whole `status` call took
// 0.34–0.40 s on a good call, while the sign-in check alone took 2.6–3.5 s on a bad one.
//
// This project signs access tokens with an ASYMMETRIC key (ES256, with a `kid`), published at
// /auth/v1/.well-known/jwks.json. A signature that verifies against that key, with the right
// issuer and audience and an unexpired `exp`, proves the token is ours and current. What it
// cannot prove is that the session is still alive — a signed-out token keeps a valid
// signature until it expires. That half is answered by the database instead, in the same
// query that finds the caller's business (resolve_caller, migration 257), so sign-out still
// takes effect immediately and the fast path costs no extra round trip.
//
// THREE answers, and the third is load-bearing:
//   verified  — signature, issuer, audience and expiry all check out; carries sub/email/session.
//   invalid   — the token itself is definitively bad: expired, forged, wrong issuer/audience,
//               malformed. The caller refuses, exactly as getUser() would have.
//   unchecked — this module cannot decide: not an asymmetric token (the bare anon key is HS256
//               with no `kid`), no session_id to check, or the key set could not be fetched.
//               The caller falls back to getUser(). Slower, never weaker — nothing here ever
//               turns "could not check" into "allowed".

import * as jose from "jsr:@panva/jose@6";

export type TokenCheck =
  | { kind: "verified"; sub: string; email: string; sessionId: string; userMetadata: Record<string, unknown> }
  | { kind: "invalid"; why: "token_expired" | "token_invalid" }
  | { kind: "unchecked" };

// One key set per isolate: createRemoteJWKSet caches the keys (10 min) and refetches on an
// unknown `kid`, so a warm worker verifies with no network at all.
let keys: jose.JWTVerifyGetKey | null = null;
let issuer = "";

function ensureKeys(): boolean {
  if (keys) return true;
  const url = Deno.env.get("SUPABASE_URL");
  if (!url) return false;
  issuer = Deno.env.get("SB_JWT_ISSUER") || `${url}/auth/v1`;
  keys = jose.createRemoteJWKSet(new URL(`${url}/auth/v1/.well-known/jwks.json`), { timeoutDuration: 3000 });
  return true;
}

/** Tests only: verify against a local key set instead of the project's published one. */
export function useKeysForTest(k: jose.JWTVerifyGetKey | null, iss: string): void {
  keys = k;
  issuer = iss;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Verdicts about the TOKEN. Anything else (the key set unreachable, a timeout, an unknown kid
// after a refetch) is about our ability to check, and must fall back rather than refuse.
//
// ⚠️ An issuer or audience MISMATCH is deliberately not in this list. The signing key is this
// project's own, so a token it verifies but whose `iss` we reject almost certainly means OUR
// expected value is wrong (an env var with a trailing slash, a custom auth domain) — and
// refusing on that would sign every user out at once. Falling back lets GoTrue answer, and the
// Server-Timing `auth` desc ("network" instead of "local") shows the fast path is off.
const TOKEN_IS_BAD = new Set([
  "ERR_JWT_EXPIRED",
  "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
  "ERR_JWS_INVALID",
  "ERR_JWT_INVALID",
]);

export async function checkAccessToken(bearer: string): Promise<TokenCheck> {
  if (!bearer) return { kind: "unchecked" };
  let header: jose.ProtectedHeaderParameters;
  try {
    header = jose.decodeProtectedHeader(bearer);
  } catch {
    return { kind: "unchecked" };
  }
  // Only the asymmetric shape is checked here. HS256 (the anon and legacy service keys) has
  // no public key to verify against; GoTrue keeps answering for those, and resolveTenant's
  // existing classifier keeps naming them.
  if (!header.kid || (header.alg !== "ES256" && header.alg !== "RS256")) return { kind: "unchecked" };
  if (!ensureKeys() || !keys) return { kind: "unchecked" };
  try {
    const { payload } = await jose.jwtVerify(bearer, keys, {
      issuer,
      audience: "authenticated",
      algorithms: ["ES256", "RS256"],
    });
    const sub = typeof payload.sub === "string" ? payload.sub : "";
    const sessionId = typeof payload.session_id === "string" ? payload.session_id : "";
    // Without a session id there is nothing to check sign-out against, so this module will not
    // vouch for the token on its own.
    if (!UUID.test(sub) || !UUID.test(sessionId)) return { kind: "unchecked" };
    return {
      kind: "verified",
      sub: sub.toLowerCase(),
      email: typeof payload.email === "string" ? payload.email : "",
      sessionId: sessionId.toLowerCase(),
      // Supabase copies user_metadata into every access token; portal-feedback names the
      // submitter from it, as it did from getUser()'s user object.
      userMetadata: (payload.user_metadata && typeof payload.user_metadata === "object" && !Array.isArray(payload.user_metadata))
        ? payload.user_metadata as Record<string, unknown>
        : {},
    };
  } catch (e) {
    const code = (e as { code?: string })?.code ?? "";
    if (!TOKEN_IS_BAD.has(code)) return { kind: "unchecked" };
    return { kind: "invalid", why: code === "ERR_JWT_EXPIRED" ? "token_expired" : "token_invalid" };
  }
}
