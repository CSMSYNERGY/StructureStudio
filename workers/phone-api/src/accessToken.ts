// Twilio Access Tokens for the Voice SDKs (https://www.twilio.com/docs/iam/access-tokens).
//
// An HS256 JWT signed with an API KEY SECRET (never the auth token), header cty
// "twilio-fpa;v=1", iss = the API key SID, sub = the account SID, and a `grants` object carrying
// the identity and a voice grant. This is exactly what Twilio's own helper libraries produce;
// it is written out here because those libraries are Node-only.

import { b64urlEncode, b64urlEncodeString } from "./b64";

export interface VoiceGrant {
  incoming?: { allow: boolean };
  outgoing?: { application_sid: string; params?: Record<string, string> };
  push_credential_sid?: string;
}

export interface AccessTokenInput {
  accountSid: string;
  apiKeySid: string;
  apiKeySecret: string;
  identity: string;
  ttlSeconds: number;
  voice: VoiceGrant;
  /** Injectable clock for tests (seconds). */
  nowSeconds?: number;
}

export async function mintAccessToken(input: AccessTokenInput): Promise<string> {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const header = { typ: "JWT", alg: "HS256", cty: "twilio-fpa;v=1" };
  const voice: VoiceGrant = {};
  if (input.voice.incoming) voice.incoming = { allow: !!input.voice.incoming.allow };
  if (input.voice.outgoing) voice.outgoing = input.voice.outgoing;
  if (input.voice.push_credential_sid) voice.push_credential_sid = input.voice.push_credential_sid;
  const payload = {
    jti: `${input.apiKeySid}-${now}`,
    iss: input.apiKeySid,
    sub: input.accountSid,
    iat: now,
    nbf: now,
    exp: now + input.ttlSeconds,
    grants: { identity: input.identity, voice },
  };
  const signingInput = `${b64urlEncodeString(JSON.stringify(header))}.${b64urlEncodeString(JSON.stringify(payload))}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(input.apiKeySecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64urlEncode(sig)}`;
}

export type Platform = "chrome" | "ios" | "android";
export type BuildType = "dev" | "prod";

/**
 * Which Twilio push credential this build registers with. A wrong match means no incoming calls
 * and no error anywhere (plan section 11), so the choice lives here, in one place:
 *   iPhone development-profile builds → the APNs SANDBOX credential
 *   iPhone TestFlight / App Store     → the APNs PRODUCTION credential
 *   Android (one FCM credential; FCM has no sandbox)
 *   Chrome → none (the extension holds a live connection instead of receiving pushes)
 * Unset (or blank) → undefined: the token is still minted, without a push credential.
 */
export function pushCredentialFor(
  env: { TWILIO_PUSH_CREDENTIAL_APNS_SANDBOX?: string; TWILIO_PUSH_CREDENTIAL_APNS_PROD?: string; TWILIO_PUSH_CREDENTIAL_FCM?: string },
  platform: Platform,
  buildType: BuildType,
): string | undefined {
  const name = pushCredentialSecretFor(platform, buildType);
  // Trimmed: a SID piped into `wrangler secret put` from PowerShell arrives with a newline, and
  // Twilio would not recognise it.
  return name ? String(env[name] ?? "").trim() || undefined : undefined;
}

/** The Worker secret that holds this build's push credential SID; null for Chrome. */
export function pushCredentialSecretFor(
  platform: Platform,
  buildType: BuildType,
): "TWILIO_PUSH_CREDENTIAL_APNS_SANDBOX" | "TWILIO_PUSH_CREDENTIAL_APNS_PROD" | "TWILIO_PUSH_CREDENTIAL_FCM" | null {
  if (platform === "ios") return buildType === "dev" ? "TWILIO_PUSH_CREDENTIAL_APNS_SANDBOX" : "TWILIO_PUSH_CREDENTIAL_APNS_PROD";
  if (platform === "android") return "TWILIO_PUSH_CREDENTIAL_FCM";
  return null;
}
