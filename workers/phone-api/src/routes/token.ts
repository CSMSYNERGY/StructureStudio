// POST /token: a Twilio Access Token for the Voice SDK (SPEC section 3).
//
// Checks the login locally, then in ONE parallel round: the caller's phone context (uncached),
// their DND/forwarding settings, and whether their Auth session still exists. The session check
// is what makes "Sign out all devices" stop a lost phone from minting a fresh line: an access
// token stays valid until it expires even after every session is revoked, and this is the one
// endpoint that turns a login into a working line. It fails OPEN on an Auth outage (a phone that
// cannot get a token cannot take calls) and CLOSED on Auth saying the session is gone.
//
// `wallet` tells the apps whether outbound calls and texts are going through, for the banner
// (wallet.ts walletStateOf): ok, low (still allowed, under twice the floor) or blocked, with
// topping_up when auto top-up is on. It is the wallet floor's own answer (wallet_usage_gate,
// voice_minute), asked only while PHONE_USAGE_METERS is on and only once the caller is known,
// so a disarmed deployment pays nothing for it. Anything it cannot tell reads "ok": the floor
// itself fails open, so a banner saying "blocked" on a read error would be a lie. A blocked
// tenant with auto top-up on gets a top-up asked for here too, so "topping up" is true.

import type { Ctx, Env } from "../env";
import { mintAccessToken, pushCredentialFor, type BuildType, type Platform } from "../accessToken";
import { adminClient, callerContext } from "../db";
import { ApiError, ok, readJson } from "../http";
import { toIdentity } from "../identity";
import { bearerToken, verifySupabaseJwt } from "../jwt";
import { logFault } from "../log";
import { requestAutoTopup, walletFloorCheck, walletStateOf, type WalletState } from "../wallet";
import { onDnd } from "./voice";

export const TOKEN_TTL = 3600;
/** The setup test only needs long enough to run Twilio's preflight. */
export const PREFLIGHT_TTL = 600;

/** true = alive, false = Auth says the session is gone, null = could not tell. */
async function sessionAlive(env: Env, token: string): Promise<boolean | null> {
  try {
    const res = await fetch(`${String(env.SUPABASE_URL).replace(/\/+$/, "")}/auth/v1/user`, {
      headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY ?? "", Authorization: `Bearer ${token}` },
    });
    if (res.ok) return true;
    if (res.status === 401 || res.status === 403) return false;
    return null;
  } catch {
    return null;
  }
}

export async function token(env: Env, ec: Ctx, req: Request): Promise<Response> {
  const body = await readJson(req);
  const platform = String(body.platform ?? "") as Platform;
  const buildType = String(body.build_type ?? "prod") as BuildType;
  if (!["chrome", "ios", "android"].includes(platform)) throw new ApiError("bad_request", "Unknown platform.");
  if (!["dev", "prod"].includes(buildType)) throw new ApiError("bad_request", "Unknown build type.");
  const preflight = body.preflight === true;

  const jwt = bearerToken(req);
  if (!jwt) throw new ApiError("unauthorized");
  const claims = await verifySupabaseJwt(env, jwt);
  const admin = adminClient(env);

  const [ctx, settingsRes, alive] = await Promise.all([
    callerContext(admin, claims.sub),
    admin.from("phone_user_settings").select("dnd, dnd_until, forward_to_cell").eq("user_id", claims.sub).maybeSingle(),
    sessionAlive(env, jwt),
  ]);
  if (alive === false) throw new ApiError("unauthorized", "You were signed out. Please sign in again.");
  if (alive === null) {
    ec.waitUntil(logFault({ code: "session_check_unavailable", severity: "warn", throttleMs: 10 * 60_000, message: "Auth /user did not answer during /token; the token was issued on the local check alone." }));
  }
  if (!ctx || ctx.phone_level === "none") throw new ApiError("no_phone_access");
  if (ctx.phone_status !== "on") throw new ApiError("phone_off");

  const appSid = preflight ? env.TWILIO_ECHO_APP_SID : env.TWILIO_TWIML_APP_SID;
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_API_KEY || !env.TWILIO_API_SECRET || !appSid) {
    ec.waitUntil(logFault({ code: "token_not_configured", message: "The Twilio account SID, API key pair or TwiML App SID is missing.", throttleMs: 10 * 60_000 }));
    throw new ApiError("internal", "The phone service isn't configured yet.");
  }

  let wallet: WalletState = { state: "ok", topping_up: false };
  if (env.PHONE_USAGE_METERS === "on") {
    const verdict = await walletFloorCheck(env, admin, ctx.client_id);
    wallet = walletStateOf(verdict);
    if (verdict.refuse && verdict.autoTopupEnabled) ec.waitUntil(requestAutoTopup(env, ctx.client_id));
  }

  // Only iPhone development-profile builds get _dev: they use sandbox push and must never share
  // a push binding with the TestFlight build (plan D8).
  const identity = toIdentity(claims.sub, ctx.device_generation, platform === "ios" && buildType === "dev");
  const ttl = preflight ? PREFLIGHT_TTL : TOKEN_TTL;
  const jwtOut = await mintAccessToken({
    accountSid: env.TWILIO_ACCOUNT_SID,
    apiKeySid: env.TWILIO_API_KEY,
    apiKeySecret: env.TWILIO_API_SECRET,
    identity,
    ttlSeconds: ttl,
    voice: preflight
      ? { incoming: { allow: false }, outgoing: { application_sid: appSid } }
      : {
        incoming: { allow: true },
        outgoing: { application_sid: appSid },
        push_credential_sid: pushCredentialFor(env, platform, buildType),
      },
  });

  const s = (settingsRes.data ?? null) as { dnd?: boolean; dnd_until?: string | null; forward_to_cell?: string | null } | null;
  return ok({
    token: jwtOut,
    identity,
    ttl,
    edge: "roaming",
    user: {
      user_id: claims.sub,
      full_name: ctx.full_name,
      client_id: ctx.client_id,
      phone_level: ctx.phone_level,
      own_contacts_only: ctx.own_contacts_only,
    },
    number: ctx.number ? { e164: ctx.number.e164 } : null,
    settings: {
      dnd: s ? onDnd({ dnd: s.dnd === true, dnd_until: s.dnd_until ?? null }) : false,
      forward_to_cell: s?.forward_to_cell ?? null,
    },
    wallet,
    // What this Worker can do that older ones could not, so an app shows a button only when
    // the server behind it has the endpoint. handoff: moving a live call to the person's
    // other device (../handoff.ts, routes/handoff.ts).
    features: { handoff: true },
  });
}
