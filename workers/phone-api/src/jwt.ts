// Checking a Supabase login token locally, without a round trip to Auth.
//
// ⚠️ A DELIBERATE EXCEPTION to _shared/jwtSubject.ts's rule ("anything acting on the identity
// goes through auth.getUser()"). getUser is a network call on every request, and it is part of
// the ~2.2 s every signed-in portal-settings call pays before doing anything. The phone budgets
// are 150 to 300 ms. So the signature, exp, aud and iss are checked here against the project's
// published keys, and the things a local check cannot see are covered elsewhere:
//   • removal from the team / phone access set to none: /voice/outbound and every read re-check
//     client_users through phone_caller_context, uncached, on every request;
//   • "Sign out all devices": /token additionally asks Auth whether the session still exists
//     (routes/token.ts), which is the one place a stolen session could mint a fresh line.
//
// Keys: the project signs with ES256 and publishes them at /auth/v1/.well-known/jwks.json.
// They are cached per isolate and refetched when a token names a kid we have not seen (a key
// rotation), at most once every 30 s so a flood of forged kids cannot hammer Auth. RS256 keys in
// the same set are honoured too. HS256 is accepted ONLY when SUPABASE_JWT_SECRET is set (a
// project still on the legacy secret); with the secret unset an HS256 token is refused.

import type { Env } from "./env";
import { b64urlDecode, b64urlDecodeJson } from "./b64";
import { ApiError, UUID_RE } from "./http";

export interface AuthClaims {
  sub: string;
  exp: number;
  iat?: number;
  session_id?: string;
  email?: string;
  role?: string;
  aud?: string | string[];
  iss?: string;
  is_anonymous?: boolean;
  [k: string]: unknown;
}

interface Jwk {
  kid?: string;
  kty?: string;
  alg?: string;
  crv?: string;
  x?: string;
  y?: string;
  n?: string;
  e?: string;
  use?: string;
  key_ops?: string[];
}

type KeyEntry = { key: CryptoKey; alg: "ES256" | "RS256" };

const SKEW_S = 30;
const JWKS_TTL_MS = 10 * 60_000;
const UNKNOWN_KID_REFETCH_MS = 30_000;

let jwksCache: { url: string; keys: Map<string, KeyEntry>; fetchedAt: number } | null = null;
let inflight: Promise<void> | null = null;
/** When an UNKNOWN kid last forced a refetch. Only those refetches are rate-limited. */
let lastForcedAt = 0;

/** Tests only: forget cached keys between cases. */
export function resetJwksCache(): void {
  jwksCache = null;
  inflight = null;
  lastForcedAt = 0;
}

async function importJwk(jwk: Jwk): Promise<KeyEntry | null> {
  try {
    const clean = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, n: jwk.n, e: jwk.e, ext: true } as JsonWebKey;
    if (jwk.kty === "EC" && jwk.crv === "P-256") {
      const key = await crypto.subtle.importKey("jwk", clean, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      return { key, alg: "ES256" };
    }
    if (jwk.kty === "RSA") {
      const key = await crypto.subtle.importKey("jwk", clean, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
      return { key, alg: "RS256" };
    }
  } catch {
    /* a key we cannot import is simply not usable */
  }
  return null;
}

async function loadJwks(url: string): Promise<void> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`jwks fetch failed: HTTP ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = new Map<string, KeyEntry>();
  for (const jwk of body.keys ?? []) {
    if (!jwk.kid) continue;
    if (jwk.use && jwk.use !== "sig") continue;
    const entry = await importJwk(jwk);
    if (entry) keys.set(jwk.kid, entry);
  }
  jwksCache = { url, keys, fetchedAt: Date.now() };
}

async function keyFor(env: Env, kid: string): Promise<KeyEntry | null> {
  const url = `${String(env.SUPABASE_URL || "").replace(/\/+$/, "")}/auth/v1/.well-known/jwks.json`;
  const now = Date.now();
  const cached = jwksCache && jwksCache.url === url ? jwksCache : null;
  const hit = cached?.keys.get(kid);
  if (hit && now - cached!.fetchedAt < JWKS_TTL_MS) return hit;

  // Refetch when there is no set, when it is stale, or when the kid is unknown (a rotation).
  // Unknown-kid refetches are what a stranger can trigger at will, so only they are limited.
  const unknownKid = !!cached && !hit && now - cached.fetchedAt < JWKS_TTL_MS;
  const mayFetch = !unknownKid || now - lastForcedAt >= UNKNOWN_KID_REFETCH_MS;
  if (mayFetch) {
    if (unknownKid) lastForcedAt = now;
    if (!inflight) inflight = loadJwks(url).finally(() => { inflight = null; });
    try {
      await inflight;
    } catch {
      // Auth unreachable: keep using what we had (a rotation is rare; an outage is not).
      return hit ?? null;
    }
  }
  return jwksCache && jwksCache.url === url ? jwksCache.keys.get(kid) ?? null : null;
}

async function hmacVerify(secret: string, data: Uint8Array, sig: Uint8Array): Promise<boolean> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, sig, data);
}

/** Verify a Supabase access token and return its claims, or throw `unauthorized`. */
export async function verifySupabaseJwt(env: Env, token: string): Promise<AuthClaims> {
  const refuse = (why: string): never => {
    throw new ApiError("unauthorized", why === "expired" ? "Your sign-in has expired. Please sign in again." : undefined);
  };
  if (!env.SUPABASE_URL) throw new ApiError("internal", "The phone service isn't configured yet.");
  const parts = String(token || "").split(".");
  if (parts.length !== 3) refuse("shape");

  let header: { alg?: string; kid?: string; typ?: string };
  let claims: AuthClaims;
  let sig: Uint8Array;
  try {
    header = b64urlDecodeJson(parts[0]);
    claims = b64urlDecodeJson<AuthClaims>(parts[1]);
    sig = b64urlDecode(parts[2]);
  } catch {
    return refuse("decode");
  }
  // Valid JSON is not yet a JWT: `null` (or an array) decodes fine, and reading .alg off it
  // would throw a TypeError past every refusal below, answering a stranger 500 instead of 401.
  const isObject = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v);
  if (!isObject(header) || !isObject(claims)) refuse("decode");
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);

  let valid = false;
  if (header.alg === "ES256" || header.alg === "RS256") {
    if (!header.kid) refuse("kid");
    const entry = await keyFor(env, header.kid!);
    if (!entry || entry.alg !== header.alg) refuse("key");
    valid = entry!.alg === "ES256"
      ? await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, entry!.key, sig, signed)
      : await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, entry!.key, sig, signed);
  } else if (header.alg === "HS256" && env.SUPABASE_JWT_SECRET) {
    valid = await hmacVerify(env.SUPABASE_JWT_SECRET, signed, sig);
  } else {
    refuse("alg");
  }
  if (!valid) refuse("signature");

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || now >= claims.exp + SKEW_S) refuse("expired");
  if (typeof claims.nbf === "number" && now + SKEW_S < (claims.nbf as number)) refuse("nbf");
  if (typeof claims.iat === "number" && now + SKEW_S < claims.iat) refuse("iat");

  const aud = claims.aud;
  const audOk = Array.isArray(aud) ? aud.includes("authenticated") : aud === "authenticated";
  if (!audOk) refuse("aud");

  const iss = `${String(env.SUPABASE_URL).replace(/\/+$/, "")}/auth/v1`;
  if (claims.iss !== iss) refuse("iss");

  if (claims.role !== undefined && claims.role !== "authenticated") refuse("role");
  if (claims.is_anonymous === true) refuse("anonymous");
  if (typeof claims.sub !== "string" || !UUID_RE.test(claims.sub)) refuse("sub");

  return claims;
}

/** The bearer token from the Authorization header, or (only where allowed) ?access_token=. */
export function bearerToken(req: Request, allowQuery = false): string | null {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  if (m) return m[1].trim();
  if (allowQuery) {
    const q = new URL(req.url).searchParams.get("access_token");
    if (q) return q;
  }
  return null;
}
