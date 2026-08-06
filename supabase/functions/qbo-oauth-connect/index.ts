/**
 * qbo-oauth-connect — start the QuickBooks OAuth round trip.
 *
 * verify_jwt = TRUE. Only a signed-in owner/admin (or a writing operator) may attach a
 * QuickBooks company to a tenant.
 *
 * Returns the Intuit authorize URL; the portal then does a full `location.assign`. Not a
 * popup: Intuit refuses to render framed, and a popup adds a blocked-popup failure mode
 * for no benefit here (the portal is a normal top-level page, unlike BuildBridge's iframe).
 */

// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";
import { resolveTenant } from "../_shared/resolveTenant.ts";
import type { GateTable } from "../_shared/access.ts";
import { qboOauthReady } from "../_shared/qboToken.ts";
import { qboEndpoints, withParams } from "../_shared/qboDiscovery.ts";

const SCOPE = "com.intuit.quickbooks.accounting";
const STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Hard allowlist for the post-OAuth landing host. An open redirect here would let a
 * crafted `returnTo` bounce a signed-in operator to an attacker's page carrying whatever
 * the callback appends. Re-checked on the callback side too — never trust that the value
 * that comes back is the value we issued.
 */
// Rebrand 2026-08-05: keep the old-domain entries until its sunset redirect ships.
const ALLOWED_HOSTS = new Set([
  "app.structurestudiosuite.com",
  "beta.structurestudiosuite.com",
  "structurestudio.app",
  "beta.structurestudio.app",
]);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

function b64url(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Starting an Intuit OAuth connect is a QuickBooks settings change (migration 100).
  // This function takes no `action`, so the default lands on "status" and that one entry is
  // the whole table — anything else is refused rather than inheriting a write by default.
  const resolved = await resolveTenant(req, admin, {
    gates: { status: { area: "settings_quickbooks", level: "edit" } } as GateTable,
    readActions: new Set<string>(),
  });
  if (!resolved.ok) return json(resolved.body, resolved.status);
  const { ctx } = resolved;

  // Read the app credentials at request time. Before they exist the whole feature is
  // dark, and the UI shows "awaiting Intuit approval" rather than an error — this is a
  // not-yet state, not a fault.
  if (!qboOauthReady()) {
    return json({
      oauthReady: false,
      error: "QuickBooks is not available yet — the Intuit app is still being set up.",
      clientId: ctx.clientId,
    }, 503);
  }

  const redirectUri = Deno.env.get("QBO_REDIRECT_URI")
    ?? `${Deno.env.get("SUPABASE_URL")}/functions/v1/qbo-oauth-callback`;

  // Where to land the browser afterwards. Validated against the allowlist; anything else
  // silently falls back to production rather than erroring — a bad returnTo is not worth
  // blocking a connect over.
  let returnHost = "app.structurestudiosuite.com";
  const rawReturn = typeof ctx.payload?.returnTo === "string" ? ctx.payload.returnTo : "";
  if (rawReturn) {
    try {
      const h = new URL(rawReturn.includes("://") ? rawReturn : `https://${rawReturn}`).hostname;
      if (ALLOWED_HOSTS.has(h)) returnHost = h;
    } catch { /* keep the default */ }
  }

  // 32 bytes of CSRF nonce. The callback matches this against the SERVER-stored copy, so
  // the state blob itself needs no signature — it is routing data, not a credential.
  const nonce = b64url(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

  // UPSERT, not update. PostgREST reports NO error when an UPDATE matches zero rows, so with an
  // update this returned {oauthReady:true, authorizeUrl} having stored nothing at all — and
  // admin-catalog's create_client only inserts a client_settings row when the tenant is
  // billing-exempt or discounted ("A normal new client gets no row here"), while portal-billing's
  // subscribe never creates one. So a normal billable tenant who opened Settings → QuickBooks
  // before ever saving the Connection tab got a working Intuit authorize URL, authorised the right
  // company, and landed back on connected=0&reason=state — every time, with no server-side error
  // anywhere, and nothing hinting that the fix was to save an unrelated form first.
  const { error: saveErr } = await admin.from("client_settings").upsert({
    client_id: ctx.clientId,
    qbo_oauth_state: nonce,
    qbo_oauth_state_expires_at: new Date(Date.now() + STATE_TTL_MS).toISOString(),
  }, { onConflict: "client_id" });

  if (saveErr) {
    return json({ error: "Could not start the QuickBooks connection.", clientId: ctx.clientId }, 500);
  }

  await ctx.audit("qbo_oauth_start", 1, null);

  const state = b64url(JSON.stringify({ cid: ctx.clientId, n: nonce, rt: returnHost }));
  // Read AFTER the nonce is saved and the audit row is written: those are the steps that must not
  // be skipped, and qboEndpoints() falls back rather than failing, so ordering it here costs
  // nothing and keeps a slow metadata host from delaying a write we care about.
  const { authorize } = await qboEndpoints();
  // withParams, NOT `${authorize}?${new URLSearchParams(params)}`. The left-hand side is no longer
  // a constant we control — it comes from Intuit's discovery document — and a query component is
  // legal there (RFC 6749 §3.1), so concatenating a second "?" would corrupt the request. The
  // reasoning and the unit tests live with the helper in _shared/qboDiscovery.ts.
  const authorizeUrl = withParams(authorize, {
    client_id: Deno.env.get("QBO_CLIENT_ID")!,
    response_type: "code",
    scope: SCOPE,
    redirect_uri: redirectUri,
    state,
  });

  // clientId is echoed as the operator view-as tripwire the portal already checks.
  return json({ oauthReady: true, authorizeUrl, clientId: ctx.clientId });
});
