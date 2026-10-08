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
import { mintAccessToken, pushCredentialFor, pushCredentialSecretFor, type BuildType, type Platform } from "../accessToken";
import { adminClient, callerContext } from "../db";
import { ApiError, ok, readJson } from "../http";
import { toIdentity } from "../identity";
import { bearerToken, verifySupabaseJwt } from "../jwt";
import { logFault } from "../log";
import { armedFor } from "../recording";
import { maySendToContacts } from "../scope";
import { requestAutoTopup, walletFloorCheck, walletStateOf, type WalletState } from "../wallet";
import { greetingOut } from "./me";
import { onDnd } from "./voice";
import { callerTwilioEnv } from "../twilioAccount";

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
    // ⚠️ dnd_cover_user_id, ring_hours, ring_hours_tz and the greeting columns are migration 264's:
    // this Worker must not be deployed before it is applied.
    admin.from("phone_user_settings")
      .select("dnd, dnd_until, forward_to_cell, dnd_cover_user_id, ring_hours, ring_hours_tz, greeting_recording_sid, greeting_updated_at")
      .eq("user_id", claims.sub).maybeSingle(),
    sessionAlive(env, jwt),
  ]);
  if (alive === false) throw new ApiError("unauthorized", "You were signed out. Please sign in again.");
  if (alive === null) {
    ec.waitUntil(logFault({ code: "session_check_unavailable", severity: "warn", throttleMs: 10 * 60_000, message: "Auth /user did not answer during /token; the token was issued on the local check alone." }));
  }
  if (!ctx || ctx.phone_level === "none") throw new ApiError("no_phone_access");
  if (ctx.phone_status !== "on") throw new ApiError("phone_off");

  // ── WHICH ACCOUNT SIGNS THE TOKEN (Workstream 2, phase 5) ──────────────────────────────────
  // A Voice token must be signed with an API key of the SAME account its TwiML App and push
  // credential live in (Twilio error 31203), so all three come from one account: the business's
  // own sub-account when it has one (its key, its app, its push credential: scopedTwilioEnv clears
  // anything the sub lacks rather than lending it the parent's), the parent otherwise. Switch off:
  // `env` itself, nothing looked up. The SETUP TEST stays on the parent whatever the business is:
  // its Echo app (TWILIO_ECHO_APP_SID) is the parent's, so it is signed with the parent's key.
  const acct = preflight ? env : await callerTwilioEnv(env, { admin, ctx });
  const appSid = preflight ? env.TWILIO_ECHO_APP_SID : acct.TWILIO_TWIML_APP_SID;
  if (!acct.TWILIO_ACCOUNT_SID || !acct.TWILIO_API_KEY || !acct.TWILIO_API_SECRET || !appSid) {
    const sub = acct !== env;
    ec.waitUntil(logFault({
      code: "token_not_configured", throttleMs: 10 * 60_000, ...(sub ? { clientId: ctx.client_id } : {}),
      message: sub
        ? "This business's Twilio sub-account has no API key pair or no TwiML App yet: its tokens can't be minted (finish it in the operator console)."
        : "The Twilio account SID, API key pair or TwiML App SID is missing.",
    }));
    throw new ApiError("internal", "The phone service isn't configured yet.");
  }

  let wallet: WalletState = { state: "ok", topping_up: false };
  if (env.PHONE_USAGE_METERS === "on") {
    const verdict = await walletFloorCheck(env, admin, ctx.client_id);
    wallet = walletStateOf(verdict);
    if (verdict.refuse && verdict.autoTopupEnabled) ec.waitUntil(requestAutoTopup(env, ctx.client_id));
  }

  // Only the iPhone development client gets _dev: it is a separate app (its own bundle id and
  // push credential) and must never share a push binding with the store build (plan D8).
  const identity = toIdentity(claims.sub, ctx.device_generation, platform === "ios" && buildType === "dev");
  const ttl = preflight ? PREFLIGHT_TTL : TOKEN_TTL;
  // A phone's token without a push credential still signs the person in and still places calls,
  // but Twilio refuses to register it for incoming ones. That is a missing secret, not the
  // person's problem: logged by name, and `incoming_push: false` tells the app why.
  const pushCredential = preflight ? undefined : pushCredentialFor(acct, platform, buildType);
  const wantsPush = !preflight && platform !== "chrome";
  if (wantsPush && !pushCredential) {
    const name = String(pushCredentialSecretFor(platform, buildType));
    ec.waitUntil(logFault({
      code: `token_no_${name.toLowerCase()}`, severity: "warn", throttleMs: 10 * 60_000,
      message: `${name} is not set: ${platform} ${buildType} builds sign in, but can't register for incoming calls.`,
    }));
  }
  const jwtOut = await mintAccessToken({
    accountSid: acct.TWILIO_ACCOUNT_SID,
    apiKeySid: acct.TWILIO_API_KEY,
    apiKeySecret: acct.TWILIO_API_SECRET,
    identity,
    ttlSeconds: ttl,
    voice: preflight
      ? { incoming: { allow: false }, outgoing: { application_sid: appSid } }
      : {
        incoming: { allow: true },
        outgoing: { application_sid: appSid },
        push_credential_sid: pushCredential,
      },
  });

  const s = (settingsRes.data ?? null) as {
    dnd?: boolean; dnd_until?: string | null; forward_to_cell?: string | null; dnd_cover_user_id?: string | null;
    ring_hours?: Record<string, unknown> | null; ring_hours_tz?: string | null;
    greeting_recording_sid?: string | null; greeting_updated_at?: string | null;
  } | null;
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
      // May they text a SAVED contact? The rule /sms/send checks first, so an app can hide the
      // composer on a customer's thread instead of letting Send fail. Replies to an unknown number
      // that texted first follow a different rule (sms.ts) and do not read this.
      can_text_contacts: maySendToContacts(ctx),
    },
    // The number this person's calls show: their own number when the business gave them one
    // (migration 266), else a team line. The apps say "Your number".
    number: ctx.number ? { e164: ctx.number.e164 } : null,
    // Every number of the business (migration 266), so the apps can tell a teammate's transfer,
    // which rings From one of them, from a customer. An older app reads `number` alone.
    numbers: ctx.numbers,
    settings: {
      dnd: s ? onDnd({ dnd: s.dnd === true, dnd_until: s.dnd_until ?? null }) : false,
      forward_to_cell: s?.forward_to_cell ?? null,
      // Who rings in this person's place while they're away (migration 264), or null.
      dnd_cover_user_id: s?.dnd_cover_user_id ?? null,
      // The hours this person's phone rings and their zone (migration 264), or null for always.
      // The apps show them; they're changed in Structure Studio.
      ring_hours: s?.ring_hours && typeof s.ring_hours === "object" && !Array.isArray(s.ring_hours) ? s.ring_hours : null,
      ring_hours_tz: s?.ring_hours_tz ?? null,
      // Their own voicemail greeting (migration 264): whether they recorded one, and when. The
      // apps offer Record, Play and "Use the standard greeting" when this is here.
      greeting: greetingOut(s),
    },
    wallet,
    // Are this business's calls recorded (and announced) right now: its owner's choice and this
    // Worker's CALL_RECORDING rail together (../recording.ts armedFor), so the apps can say
    // "Calls are recorded" in settings. A single call's own state is GET /calls `recording`.
    recording: { on: armedFor(env, ctx.recording) },
    // What this Worker can do that older ones could not, so an app shows a button only when
    // the server behind it has the endpoint. handoff: moving a live call to the person's
    // other device (../handoff.ts, routes/handoff.ts). recordings: GET /recordings/:id/audio and
    // GET /calls/:id/transcript, and the recording keys on a call (routes/reads.ts).
    features: { handoff: true, recordings: true },
    // Whether this token can register the phone for incoming calls (it carries the build's push
    // credential). false: the Worker has no credential for this platform and build, so register()
    // would only fail. null: not a phone token (the extension, or the setup test).
    incoming_push: wantsPush ? !!pushCredential : null,
  });
}
