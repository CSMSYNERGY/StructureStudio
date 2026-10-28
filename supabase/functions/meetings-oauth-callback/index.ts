/**
 * meetings-oauth-callback — the return leg of "Connect Zoom" (migration 333).
 *
 * ⛔ verify_jwt MUST STAY FALSE. Zoom redirects the person's BROWSER here with no Supabase
 * JWT; with verification on, the gateway 401s every callback before this runs and connecting
 * silently becomes impossible (the billing-webhook / qbo-oauth-callback lesson).
 * `supabase/config.toml` pins it; check `list_edge_functions` after every deploy.
 *
 * Auth is the one-shot `state` portal-meetings' `video_connect` wrote to meeting_oauth_states:
 * it says whose host row the tokens belong to, so the person is never read from this request.
 * The row is DELETED before the code is exchanged, so a state can be used once, ever.
 *
 * The browser only ever sees `?video=connected` or `?video=0&reason=<slug>` — no tokens, no
 * account ids, no provider error text.
 *
 * Built for Zoom. Google and Microsoft land here too when their connectors are built: the
 * state row already carries the provider.
 */

// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";
import { logEdgeError } from "../_shared/logError.ts";
import { zoomCredsFromEnv, zoomExchangeCode, zoomMe } from "../_shared/zoomApi.ts";
import { googleCredsFromEnv, googleExchangeCode, googleMe } from "../_shared/googleCalendarApi.ts";
import { msCredsFromEnv, msExchangeCode, msMe } from "../_shared/microsoftGraphApi.ts";
import { syncConnectionBusy, type CalConn } from "../_shared/meetingCalendar.ts";
import { denoVideoEnv } from "../_shared/meetingVideo.ts";
import { MEETINGS_OAUTH_HOSTS, meetingsOauthRedirectUri } from "../_shared/meetingOauth.ts";

const DEFAULT_HOST = "app.structurestudiosuite.com";

// My Profile at its /portal address ON PURPOSE, for the reason qbo-oauth-callback gives: an
// edge deploy is live for production at once, and /portal/… works on both the old and the new
// _redirects (CLAUDE.md, "App addresses").
//
// It was /portal/settings/meetings until 2026-10-23, when the per-person connections moved into
// My Profile as one tabbed segment (MyConnectionsCard). Safe to change in one step because the
// connect flow is days old and nobody on production can start one: a browser can only land here
// carrying a state row that portal-meetings' video_connect wrote minutes earlier.
function land(host: string, params: Record<string, string>): Response {
  const safeHost = MEETINGS_OAUTH_HOSTS.has(host) ? host : DEFAULT_HOST;
  return new Response(null, {
    status: 302,
    headers: { Location: `https://${safeHost}/portal/settings/myprofile?${new URLSearchParams(params)}` },
  });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const state = (url.searchParams.get("state") ?? "").slice(0, 128);
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(state)) return land(DEFAULT_HOST, { video: "0", reason: "state" });

  // Burn it first: whatever happens next, this state is spent.
  const { data: st, error: se } = await admin.from("meeting_oauth_states")
    .delete().eq("state", state).select("*").maybeSingle();
  if (se || !st) return land(DEFAULT_HOST, { video: "0", reason: "state" });
  const host = MEETINGS_OAUTH_HOSTS.has(st.return_host) ? st.return_host : DEFAULT_HOST;
  if (new Date(st.expires_at).getTime() < Date.now()) return land(host, { video: "0", reason: "state" });

  // They pressed Cancel / Decline at the provider.
  if (url.searchParams.get("error")) return land(host, { video: "0", reason: "denied" });
  const code = url.searchParams.get("code") ?? "";
  if (!code) return land(host, { video: "0", reason: "denied" });

  // Zoom (333), Google and Microsoft (341) share this one return leg; the state row says which.
  const provider = String(st.provider);
  const get = (k: string) => Deno.env.get(k);
  const zoomCreds = provider === "zoom" ? zoomCredsFromEnv(get) : null;
  const googleCreds = provider === "google" ? googleCredsFromEnv(get) : null;
  const msCreds = provider === "microsoft" ? msCredsFromEnv(get) : null;
  if (!zoomCreds && !googleCreds && !msCreds) {
    return land(host, { video: "0", reason: ["zoom", "google", "microsoft"].includes(provider) ? "not_set_up" : "provider", provider });
  }

  // The host row must still be this person's, on this tenant. A host deleted in the ten
  // minutes since cascades the state away, so this is belt and braces.
  const { data: hostRow } = await admin.from("meeting_hosts")
    .select("id, user_id, client_id").eq("id", st.host_id).maybeSingle();
  if (!hostRow || hostRow.user_id !== st.user_id || hostRow.client_id !== st.client_id) {
    return land(host, { video: "0", reason: "state" });
  }

  const redirect = meetingsOauthRedirectUri(provider, st.return_host);
  let tokens: { accessToken: string; refreshToken: string | null; expiresAt: string };
  try {
    tokens = zoomCreds ? await zoomExchangeCode(zoomCreds, code, redirect)
      : googleCreds ? await googleExchangeCode(googleCreds, code, redirect)
      : await msExchangeCode(msCreds!, code, redirect);
  } catch (e) {
    await logEdgeError({
      fn: "meetings-oauth-callback", req, clientId: st.client_id, code: `${provider}_exchange`,
      message: `${provider} did not accept the connection: ${(e as Error)?.message}`,
    });
    return land(host, { video: "0", reason: "exchange", provider });
  }
  // Without a refresh token the connection dies when the hour-long access token does. Google
  // only sends one with access_type=offline&prompt=consent, which the connect URL asks for.
  if (!tokens.refreshToken) {
    await logEdgeError({ fn: "meetings-oauth-callback", req, clientId: st.client_id, code: `${provider}_no_refresh`, message: `${provider} returned no refresh token.` });
    return land(host, { video: "0", reason: "exchange", provider });
  }

  // Who they connected, so the page can say "Connected as …". Best effort.
  let me: { id: string; email: string | null; name: string | null } | null = null;
  try {
    me = zoomCreds ? await zoomMe(tokens.accessToken)
      : googleCreds ? await googleMe(tokens.accessToken)
      : await msMe(tokens.accessToken);
  } catch { /* shown as "Connected" without a name */ }

  const { error: ue } = await admin.from("meeting_connections").upsert({
    client_id: st.client_id,
    host_id: st.host_id,
    user_id: st.user_id,
    provider,
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    token_expires: tokens.expiresAt,
    status: "connected",
    account_email: me?.email ?? null,
    account_name: me?.name ?? null,
    external_account_id: me?.id || null,
    last_error: null,
    updated_at: new Date().toISOString(),
  }, { onConflict: "host_id,provider" });
  if (ue) {
    await logEdgeError({
      fn: "meetings-oauth-callback", req, clientId: st.client_id, code: "save",
      message: `Could not save the ${provider} connection: ${ue.message}`,
    });
    return land(host, { video: "0", reason: "save" });
  }

  // The audit row is written when the connect STARTS (portal-meetings `video_connect`, which
  // has the signed-in person); this leg has only the state row's word for who it is.
  // A calendar: read its busy times NOW, so the booking page reflects them before the next
  // 5-minute tick. Best effort and bounded: a slow provider never holds up the landing.
  if (provider === "google" || provider === "microsoft") {
    const { data: row } = await admin.from("meeting_connections")
      .select("id, client_id, host_id, user_id, provider, status, access_token, refresh_token, token_expires, busy_calendar_ids, write_calendar_id")
      .eq("host_id", st.host_id).eq("provider", provider).maybeSingle();
    if (row) {
      await Promise.race([
        syncConnectionBusy(admin, row as CalConn, denoVideoEnv()),
        new Promise((r) => setTimeout(r, 8_000)),
      ]).catch(() => {});
    }
  }
  return land(host, { video: "connected", provider });
});
