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
 * The redirect URI registered with the provider.
 *
 * ZOOM: the callback FUNCTION's own address — what is registered in the Zoom app today, and
 * Zoom shows the app's name on its screen whatever the address.
 *
 * GOOGLE and MICROSOFT (341): `oauth-callback.html` on OUR domain, which hands the query on to
 * that same function. Google shows the redirect address's domain on its sign-in screen until
 * the app's branding is verified, and verifies only domains we own — it said
 * "jzeamjbhdrsbygdnphbm.supabase.co" (Carolyn 2026-10-28: "This should say Structure Studio, not
 * Supabase"). One URI per host, because the page must be served by the host the person started
 * on (production serves main, beta serves beta); both are registered with the provider. The
 * connect and the callback derive it from the same stored return host, so the exchange always
 * presents exactly the URI the authorize request used.
 */
export function meetingsOauthRedirectUri(provider?: string, returnHost?: string | null): string {
  if (provider === "google" || provider === "microsoft") {
    const host = String(returnHost || "").startsWith("beta.") ? "beta.structurestudiosuite.com" : "app.structurestudiosuite.com";
    return `https://${host}/oauth-callback.html`;
  }
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
