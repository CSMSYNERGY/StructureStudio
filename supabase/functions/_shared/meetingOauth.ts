// meetingOauth.ts — the pieces "Connect Zoom" and its callback must agree on (migration 333).

/**
 * Hosts a connect may land back on. An open redirect here would bounce a signed-in person to
 * any page carrying whatever the callback appends, so the connect refuses anything else and
 * the callback re-checks the stored value. Same list as qbo-oauth-connect.
 */
export const MEETINGS_OAUTH_HOSTS = new Set([
  "app.structurestudiosuite.com",
  "beta.structurestudiosuite.com",
  "structurestudio.app",
  "beta.structurestudio.app",
]);

/**
 * The redirect URI registered with the provider. It is the CALLBACK FUNCTION's address, not a
 * portal page, so one value serves beta and production. Carolyn pastes exactly this into the
 * Zoom app's "OAuth Redirect URL" and "Add allow lists".
 */
export function meetingsOauthRedirectUri(): string {
  const override = (Deno.env.get("MEETINGS_OAUTH_REDIRECT_URI") || "").trim();
  if (override) return override;
  return `${Deno.env.get("SUPABASE_URL")}/functions/v1/meetings-oauth-callback`;
}

/** An unguessable, URL-safe one-shot state. */
export function newOauthState(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const OAUTH_STATE_TTL_MS = 10 * 60_000;
