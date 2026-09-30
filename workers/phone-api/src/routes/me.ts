// The signed-in person's own things: POST /settings/me, /devices, /devices/signout-all, /log,
// and GET /turn and /health.

import type { Ctx, Env } from "../env";
import { WORKER_VERSION } from "../env";
import { requireCaller, requireLogin } from "../context";
import { adminClient, must } from "../db";
import { ApiError, ok, readJson } from "../http";
import { isPremiumRate, toE164 } from "../identity";
import { logFault } from "../log";
import { ntsToken } from "../twilioRest";
import { onDnd } from "./voice";

// ── POST /settings/me ───────────────────────────────────────────────────────────────

const MAX_DND_MS = 30 * 86_400_000;

export async function settingsMe(env: Env, req: Request): Promise<Response> {
  const c = await requireCaller(env, req, { needOn: false });
  const body = await readJson(req);
  const patch: Record<string, unknown> = {};

  if (body.dnd !== undefined) {
    if (typeof body.dnd !== "boolean") throw new ApiError("bad_request", "Do Not Disturb must be on or off.");
    patch.dnd = body.dnd;
    if (body.dnd === false) patch.dnd_until = null;
  }
  if (body.dnd_until !== undefined && body.dnd !== false) {
    if (body.dnd_until === null || body.dnd_until === "") {
      patch.dnd_until = null;
    } else {
      const t = Date.parse(String(body.dnd_until));
      if (!Number.isFinite(t) || t <= Date.now() || t - Date.now() > MAX_DND_MS) {
        throw new ApiError("bad_request", "Pick an end time for Do Not Disturb within the next 30 days.");
      }
      patch.dnd_until = new Date(t).toISOString();
    }
  }
  if (body.forward_to_cell !== undefined) {
    if (body.forward_to_cell === null || body.forward_to_cell === "") {
      patch.forward_to_cell = null;
    } else {
      const cell = toE164(String(body.forward_to_cell));
      if (!cell || isPremiumRate(cell)) throw new ApiError("bad_request", "That cell number isn't a US or Canadian number.");
      // Forwarding the business line to itself would ring the same Dial forever.
      if (c.ctx.number && cell === c.ctx.number.e164) throw new ApiError("bad_request", "That's your business number. Enter your own cell phone.");
      patch.forward_to_cell = cell;
    }
  }

  const row = { user_id: c.userId, client_id: c.ctx.client_id, updated_at: new Date().toISOString(), ...patch };
  const saved = must(
    await c.admin.from("phone_user_settings").upsert(row, { onConflict: "user_id" }).select("dnd, dnd_until, forward_to_cell").single(),
    "save phone settings",
  ) as { dnd: boolean; dnd_until: string | null; forward_to_cell: string | null } | null;
  const s = saved ?? { dnd: false, dnd_until: null, forward_to_cell: null };
  return ok({
    settings: {
      dnd: onDnd({ dnd: s.dnd === true, dnd_until: s.dnd_until }),
      dnd_until: s.dnd_until ?? null,
      forward_to_cell: s.forward_to_cell ?? null,
    },
  });
}

// ── POST /devices ───────────────────────────────────────────────────────────────────

export async function devices(env: Env, req: Request): Promise<Response> {
  const c = await requireCaller(env, req, { needOn: false });
  const body = await readJson(req);
  const platform = String(body.platform ?? "");
  const buildType = String(body.build_type ?? "prod");
  if (!["chrome", "ios", "android"].includes(platform)) throw new ApiError("bad_request", "Unknown platform.");
  if (!["dev", "prod"].includes(buildType)) throw new ApiError("bad_request", "Unknown build type.");
  const pushToken = body.push_token == null || body.push_token === "" ? null : String(body.push_token);
  const pushKind = body.push_kind == null || body.push_kind === "" ? null : String(body.push_kind);
  if (pushToken && (pushToken.length > 4096 || !/^[\w:.\-]+$/.test(pushToken))) throw new ApiError("bad_request", "That push token isn't valid.");
  const expectedKind = platform === "ios" ? "apns" : platform === "android" ? "fcm" : null;
  if (pushToken && pushKind !== expectedKind) throw new ApiError("bad_request", "That push token doesn't match the platform.");
  const appVersion = String(body.app_version ?? "").slice(0, 40) || null;
  const now = new Date().toISOString();
  const row = {
    user_id: c.userId, client_id: c.ctx.client_id, platform, build_type: buildType,
    push_token: pushToken, push_kind: pushToken ? pushKind : null, app_version: appVersion, last_seen_at: now,
  };

  if (pushToken) {
    // A token belongs to one device. If someone else signed in on it before, their text alerts
    // must stop arriving here.
    must(await c.admin.from("phone_devices").delete().eq("push_token", pushToken).neq("user_id", c.userId), "release push token");
    must(await c.admin.from("phone_devices").upsert(row, { onConflict: "user_id,platform,push_token" }), "register device");
  } else {
    // No token (the extension): one row per person and platform. A NULL never conflicts in a
    // unique index, so this is found and updated by hand instead of upserted.
    const existing = must(
      await c.admin.from("phone_devices").select("id").eq("user_id", c.userId).eq("platform", platform).is("push_token", null).limit(1),
      "find device",
    ) as { id: string }[] | null;
    if (existing?.length) {
      must(await c.admin.from("phone_devices").update(row).eq("id", existing[0].id), "update device");
    } else {
      must(await c.admin.from("phone_devices").insert(row), "register device");
    }
  }
  return ok();
}

// ── POST /devices/forget ────────────────────────────────────────────────────────────

/**
 * Sign-out on one phone. The app unregisters the line with Twilio itself, but text alerts go
 * to the push token saved here, so without this a signed-out phone kept showing customers'
 * texts (seen on Android, 2026-09-30). Deletes only the caller's own row for that token.
 * Needs a login only: someone whose phone access was removed must still be able to stop them.
 */
export async function forgetDevice(env: Env, req: Request): Promise<Response> {
  const { admin, userId } = await requireLogin(env, req);
  const body = await readJson(req);
  const platform = String(body.platform ?? "");
  if (!["ios", "android"].includes(platform)) throw new ApiError("bad_request", "Unknown platform.");
  const pushToken = body.push_token == null ? "" : String(body.push_token);
  if (!pushToken || pushToken.length > 4096 || !/^[\w:.\-]+$/.test(pushToken)) throw new ApiError("bad_request", "That push token isn't valid.");
  must(await admin.from("phone_devices").delete().eq("user_id", userId).eq("platform", platform).eq("push_token", pushToken), "forget device");
  return ok();
}

// ── POST /devices/signout-all ───────────────────────────────────────────────────────

/**
 * A lost phone (plan section 14). Three things, in this order:
 *   1. bump device_generation, so every identity minted before now is retired: inbound routing
 *      rings only the new one, and /voice/outbound refuses the old one;
 *   2. forget every registered push token, so text alerts stop reaching the lost device;
 *   3. end every Supabase login session for this person (Auth's global sign-out). /token checks
 *      the session, so the lost phone cannot mint a new line even while its access token lives.
 * Deliberately needs a login only, not phone access: removing access must not remove the way
 * to lock a lost phone out.
 */
export async function signOutAll(env: Env, req: Request): Promise<Response> {
  const { admin, userId, token, ctx } = await requireLogin(env, req);

  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = must(
      await admin.from("phone_user_settings").select("device_generation").eq("user_id", userId).maybeSingle(),
      "read device generation",
    ) as { device_generation: number } | null;
    if (!cur) {
      if (!ctx?.client_id) break; // never had a line, nothing to retire
      const { error } = await admin.from("phone_user_settings").insert({ user_id: userId, client_id: ctx.client_id, device_generation: 2 });
      if (!error) break;
      continue; // a row appeared under us: bump that one
    }
    const next = (Number(cur.device_generation) || 1) + 1;
    const bumped = must(
      await admin.from("phone_user_settings").update({ device_generation: next, updated_at: new Date().toISOString() })
        .eq("user_id", userId).eq("device_generation", cur.device_generation).select("user_id"),
      "bump device generation",
    ) as unknown[] | null;
    if (bumped?.length) break;
  }

  must(await admin.from("phone_devices").delete().eq("user_id", userId), "forget devices");

  const { error } = await admin.auth.admin.signOut(token, "global");
  if (error) {
    await logFault({ code: "signout_all_failed", message: `Auth global sign-out failed: ${error.message}`, clientId: ctx?.client_id ?? null });
    throw new ApiError("internal", "Your phone line was reset, but we couldn't sign out your other sessions. Please try again.");
  }
  return ok();
}

// ── POST /log ───────────────────────────────────────────────────────────────────────

const LOG_SOURCES = new Set(["sss-phone-extension", "sss-phone-mobile"]);
const LOG_SEVERITIES = new Set(["error", "warn", "info"]);
const perUser = new Map<string, { windowStart: number; n: number }>();
const LOG_PER_MINUTE = 30;

/**
 * App errors into app_errors, at the severity the app chose (plan section 14: log_error would
 * demote a chrome-extension:// page to info, so the apps come through here instead).
 */
export async function log(env: Env, req: Request): Promise<Response> {
  const { admin, userId, ctx } = await requireLogin(env, req);
  const body = await readJson(req);
  const source = String(body.source ?? "");
  if (!LOG_SOURCES.has(source)) throw new ApiError("bad_request", "Unknown log source.");
  const severity = LOG_SEVERITIES.has(String(body.severity)) ? String(body.severity) : "error";
  const message = String(body.message ?? "").trim().slice(0, 4000);
  if (!message) throw new ApiError("bad_request", "The log message is empty.");

  // A crash loop in one app must not flood the table.
  const now = Date.now();
  const w = perUser.get(userId);
  if (!w || now - w.windowStart > 60_000) perUser.set(userId, { windowStart: now, n: 1 });
  else if (++w.n > LOG_PER_MINUTE) return ok({ dropped: true });

  let context: Record<string, unknown> = {};
  if (body.context && typeof body.context === "object" && !Array.isArray(body.context)) {
    const encoded = JSON.stringify(body.context);
    context = encoded.length > 8000 ? { _truncated: true, bytes: encoded.length } : (body.context as Record<string, unknown>);
  }
  const { error } = await admin.from("app_errors").insert({
    source,
    severity,
    code: body.code == null ? null : String(body.code).slice(0, 100),
    message,
    url: null,
    user_agent: (req.headers.get("user-agent") ?? "").slice(0, 400) || null,
    client_id: ctx?.client_id ?? null,
    context: { ...context, app_version: String(body.app_version ?? "").slice(0, 40) || null, user_id: userId },
  });
  if (error) throw new ApiError("internal", "The error report couldn't be saved.");
  return ok();
}

// ── GET /turn ───────────────────────────────────────────────────────────────────────

export async function turn(env: Env, ec: Ctx, req: Request): Promise<Response> {
  await requireCaller(env, req);
  try {
    return ok({ ice_servers: await ntsToken(env, 3600) });
  } catch (e) {
    ec.waitUntil(logFault({ code: "turn_failed", message: (e as Error).message, throttleMs: 60_000 }));
    throw new ApiError("twilio_error", "Couldn't get relay servers for calls. Please try again.");
  }
}

// ── GET /health ─────────────────────────────────────────────────────────────────────

export async function health(env: Env, warm = false): Promise<Response> {
  if (!warm) return ok({ version: WORKER_VERSION, deployment: env.CF_VERSION_METADATA?.id ?? null });
  // Keep-warm (the every-minute tick calls this through the public URL, so it lands on the
  // placed isolate next to Supabase): one tiny read keeps the isolate and its TLS connection
  // to PostgREST warm for the next Twilio webhook. It reads an id only and never fails loudly.
  const t0 = Date.now();
  let db = true;
  try {
    const { error } = await adminClient(env).from("sms_numbers").select("id").limit(1);
    if (error) db = false;
  } catch {
    db = false;
  }
  return ok({ version: WORKER_VERSION, deployment: env.CF_VERSION_METADATA?.id ?? null, warm: true, db, db_ms: Date.now() - t0 });
}
