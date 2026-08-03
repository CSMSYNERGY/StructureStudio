/**
 * qbo-oauth-callback — the return leg of the QuickBooks OAuth round trip.
 *
 * ⛔ verify_jwt MUST STAY FALSE. Intuit redirects the user's BROWSER here; there is no
 * Supabase JWT on that navigation. With verification on, the gateway 401s every callback
 * before this function runs — the same failure that silently broke billing-webhook for
 * weeks. `supabase/config.toml` pins it; check `list_edge_functions` after every deploy.
 *
 * Auth is therefore not a JWT: it is the one-shot nonce written to the tenant's row by
 * qbo-oauth-connect, compared in constant time and cleared on first match.
 *
 * Nothing sensitive ever reaches the URL — no tokens, no realm id, no error bodies. The
 * browser only ever sees `?connected=1` or `?connected=0&reason=<slug>`.
 */

// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";
import { qboApiBase } from "../_shared/qboToken.ts";

const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const ALLOWED_HOSTS = new Set(["structurestudio.app", "beta.structurestudio.app"]);
const DEFAULT_HOST = "structurestudio.app";

function land(host: string, params: Record<string, string>): Response {
  const safeHost = ALLOWED_HOSTS.has(host) ? host : DEFAULT_HOST;
  const qs = new URLSearchParams(params);
  return new Response(null, {
    status: 302,
    headers: { Location: `https://${safeHost}/portal/settings/quickbooks?${qs}` },
  });
}

/** Length-independent comparison so a mismatch leaks no timing signal. */
function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function fromB64url(s: string): string {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/");
  return atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // Decode the state first so that even a failure lands the user back on the right host.
  let cid = "", nonce = "", host = DEFAULT_HOST;
  try {
    const st = JSON.parse(fromB64url(url.searchParams.get("state") ?? ""));
    cid = typeof st?.cid === "string" ? st.cid : "";
    nonce = typeof st?.n === "string" ? st.n : "";
    // Re-validate the return host on the way back too: the state travelled through the
    // user's browser and must not be trusted just because we issued something like it.
    if (typeof st?.rt === "string" && ALLOWED_HOSTS.has(st.rt)) host = st.rt;
  } catch { /* handled below */ }

  // The user pressed Cancel at Intuit. Not an error — just say so.
  if (url.searchParams.get("error")) {
    return land(host, { connected: "0", reason: "denied" });
  }

  const code = url.searchParams.get("code") ?? "";
  const realmId = url.searchParams.get("realmId") ?? "";
  if (!cid || !nonce || !code || !realmId) {
    return land(host, { connected: "0", reason: "state" });
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // ── Match the server-stored nonce ──────────────────────────────────────────────────
  const { data: row } = await admin
    .from("client_settings")
    .select("qbo_oauth_state, qbo_oauth_state_expires_at, qbo_realm_id")
    .eq("client_id", cid)
    .maybeSingle();

  const stored = row?.qbo_oauth_state ?? "";
  const notExpired = row?.qbo_oauth_state_expires_at
    ? new Date(row.qbo_oauth_state_expires_at).getTime() > Date.now()
    : false;

  if (!stored || !notExpired || !constantTimeEqual(stored, nonce)) {
    return land(host, { connected: "0", reason: "state" });
  }

  // Burn the nonce immediately — a replayed callback must fail even if everything after
  // this point succeeds.
  await admin.from("client_settings")
    .update({ qbo_oauth_state: null, qbo_oauth_state_expires_at: null })
    .eq("client_id", cid);

  // ── Exchange the code ──────────────────────────────────────────────────────────────
  const clientId = Deno.env.get("QBO_CLIENT_ID");
  const clientSecret = Deno.env.get("QBO_CLIENT_SECRET");
  if (!clientId || !clientSecret) return land(host, { connected: "0", reason: "unconfigured" });

  const redirectUri = Deno.env.get("QBO_REDIRECT_URI")
    ?? `${Deno.env.get("SUPABASE_URL")}/functions/v1/qbo-oauth-callback`;

  let tok: any;
  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      }),
    });
    if (!res.ok) return land(host, { connected: "0", reason: "exchange" });
    tok = await res.json();
  } catch {
    return land(host, { connected: "0", reason: "exchange" });
  }

  if (!tok?.access_token || !tok?.refresh_token) {
    return land(host, { connected: "0", reason: "exchange" });
  }

  // ── Connect-verify: prove the credential works BEFORE calling it connected ─────────
  // Also the only way to learn the company NAME, which is what lets a human notice they
  // authorised the wrong QuickBooks business. A realm id alone is unrecognisable.
  let companyName: string | null = null;
  try {
    const info = await fetch(`${qboApiBase()}/v3/company/${realmId}/companyinfo/${realmId}`, {
      headers: { Authorization: `Bearer ${tok.access_token}`, Accept: "application/json" },
    });
    if (!info.ok) return land(host, { connected: "0", reason: "verify" });
    const body = await info.json();
    companyName = body?.CompanyInfo?.CompanyName ?? null;
  } catch {
    return land(host, { connected: "0", reason: "verify" });
  }

  // ── Different company than before? The old item mappings are now wrong ─────────────
  // Item ids are per-company. Silently keeping them would bill lines against whatever
  // happens to share that id in the new books — a wrong-but-plausible invoice, which is
  // worse than an obviously missing mapping.
  // ORDER MATTERS: the wipe happens AFTER the save below succeeds, never before it.
  // The save has an EXPECTED failure mode that this function already handles — the realm unique
  // index ("realm_in_use", this QuickBooks company is attached to another tenant) — and it can
  // also fail transiently. Wiping first meant that on any such failure the connection was
  // unchanged (still pointing at the old realm, old tokens, old company name) while the tenant's
  // entire hand-built item map was already gone and not restored. The owner saw the working old
  // connection in the UI, then every later Send invoice aborted with "unmapped: …" on every line,
  // with nothing indicating that a FAILED connect attempt had destroyed the mapping.
  const previousRealm = row?.qbo_realm_id ?? null;
  const realmChanged = Boolean(previousRealm && previousRealm !== realmId);

  const now = Date.now();
  const { error: saveErr } = await admin.from("client_settings").update({
    qbo_realm_id: realmId,
    qbo_company_name: companyName,
    qbo_access_token: tok.access_token,
    qbo_access_token_expires_at: new Date(now + (Number(tok.expires_in) || 3600) * 1000).toISOString(),
    qbo_refresh_token: tok.refresh_token,
    qbo_refresh_token_expires_at:
      new Date(now + (Number(tok.x_refresh_token_expires_in) || 8726400) * 1000).toISOString(),
    qbo_connected_at: new Date(now).toISOString(),
    qbo_token_refreshed_at: new Date(now).toISOString(),
    qbo_refresh_error: null,
    qbo_refreshing_at: null,
  }).eq("client_id", cid);

  if (saveErr) {
    // The realm unique index is the one expected failure: this QuickBooks company is
    // already attached to a different tenant. Naming that precisely is the whole point of
    // having the index — the alternative is two tenants quietly fighting over one token.
    const reason = /client_settings_qbo_realm_uniq|duplicate key/i.test(saveErr.message)
      ? "realm_in_use"
      : "save";
    return land(host, { connected: "0", reason });
  }

  // The connection is now definitively pointing at the new company, so the old company's item ids
  // are definitively wrong. Item ids are per-company: silently keeping them would bill lines
  // against whatever happens to share that id in the new books — a wrong-but-plausible invoice,
  // which is worse than an obviously missing mapping. Only reached once the save above committed.
  if (realmChanged) {
    const { error: mapErr } = await admin.from("qbo_item_map").delete().eq("client_id", cid);
    // A failure here leaves stale ids against a live new connection, which is the dangerous
    // direction — surface it rather than letting the first invoice discover it.
    if (mapErr) return land(host, { connected: "1", reason: "item_map_stale" });
  }

  await admin.from("admin_audit").insert({
    action: "qbo_connected",
    target_client_id: cid,
    row_count: 1,
    note: companyName ? `Connected to ${companyName}` : null,
  });

  return land(host, { connected: "1" });
});
