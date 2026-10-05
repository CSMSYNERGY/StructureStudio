// The signed-in person's own things: POST and GET /settings/me, POST /devices,
// /devices/signout-all, /log, and GET /turn and /health. (Their voicemail greeting, under
// /settings/me/greeting/*, is ./greeting.ts.)

import type { Ctx, Env } from "../env";
import { WORKER_VERSION } from "../env";
import { requireCaller, requireLogin, type Caller } from "../context";
import { adminClient, callerContext, must } from "../db";
import { ApiError, ok, readJson, UUID_RE } from "../http";
import { isPremiumRate, toE164 } from "../identity";
import { logFault } from "../log";
import { EXTENSION_LOG_SOURCES, extensionContext, pseudonymKey, reportRefs, scrubText } from "../logPrivacy";
import { ntsToken } from "../twilioRest";
import { onDnd } from "./voice";
import { parseBusinessHours, RING_HOURS_WORDS, validTimeZone } from "../../../../supabase/functions/_shared/phoneHours.ts";

// ── POST /settings/me, GET /settings/me ─────────────────────────────────────────────

const MAX_DND_MS = 30 * 86_400_000;

// ⚠️ dnd_cover_user_id, ring_hours, ring_hours_tz, greeting_recording_sid and greeting_updated_at
// are migration 264's: this Worker must not be deployed before it is applied.
export const SETTINGS_COLUMNS =
  "dnd, dnd_until, forward_to_cell, dnd_cover_user_id, ring_hours, ring_hours_tz, greeting_recording_sid, greeting_updated_at";

export interface SettingsRow {
  dnd: boolean;
  dnd_until: string | null;
  forward_to_cell: string | null;
  dnd_cover_user_id: string | null;
  ring_hours: Record<string, unknown> | null;
  ring_hours_tz: string | null;
  greeting_recording_sid: string | null;
  greeting_updated_at: string | null;
}

/**
 * Your own voicemail greeting as the apps see it (migration 264): whether there is one, and when
 * it was recorded. Never the recording's sid: the audio is GET /settings/me/greeting/audio.
 */
export function greetingOut(s: Partial<Pick<SettingsRow, "greeting_recording_sid" | "greeting_updated_at">> | null): { set: boolean; updated_at: string | null } {
  const set = !!s?.greeting_recording_sid;
  return { set, updated_at: set ? s?.greeting_updated_at ?? null : null };
}

/** phone-core's MySettings. `dnd` is the effective value: a passed end time reads as off. */
export function settingsOut(s: Partial<SettingsRow> | null) {
  const hours = s?.ring_hours;
  return {
    dnd: s ? onDnd({ dnd: s.dnd === true, dnd_until: s.dnd_until ?? null }) : false,
    dnd_until: s?.dnd_until ?? null,
    forward_to_cell: s?.forward_to_cell ?? null,
    dnd_cover_user_id: s?.dnd_cover_user_id ?? null,
    ring_hours: hours && typeof hours === "object" && !Array.isArray(hours) ? hours : null,
    ring_hours_tz: s?.ring_hours_tz ?? null,
    greeting: greetingOut(s),
  };
}

const COVER_REFUSED = "That teammate can't take calls.";

/**
 * Who rings in your place while you're away (migration 264): a teammate's user id, or null / ""
 * for nobody extra. Anyone with phone access on your own business, on the answer list or not;
 * never yourself. This is only the choice: whether they can take a call right then (access, a
 * call of their own, their own DND) is checked on every call (voice.ts ringSlots, calls.ts).
 */
async function coverChoice(c: Caller, v: unknown): Promise<string | null> {
  if (v === null || v === "") return null;
  const id = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (!UUID_RE.test(id) || id === c.userId.toLowerCase()) throw new ApiError("bad_request", COVER_REFUSED);
  const ctx = await callerContext(c.admin, id);
  if (!ctx || ctx.client_id !== c.ctx.client_id || ctx.phone_level === "none") throw new ApiError("bad_request", COVER_REFUSED);
  return id;
}

// Your own hours (migration 264): refusals in the person's words.
const HOURS_NO_DAYS = "Add hours to at least one day, or choose Always.";
const HOURS_NO_ZONE = "Choose the time zone your hours are in.";
const HOURS_BAD_ZONE = "That time zone isn't one we know. Pick it from the list.";

/**
 * The hours your phone rings (migration 264): `ring_hours` null for always (whenever the business
 * is open), or business hours' weekly shape, checked by the rule the owner's hours pass
 * (_shared/phoneHours.ts), with at least one day; `ring_hours_tz` the zone they're in (the apps
 * and the portal send the device's), required with hours. Outside them you count as away, like
 * DND (voice.ts isAway). Neither touches the business's own hours, which stay the outer gate.
 */
function hoursPatch(body: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (body.ring_hours !== undefined) {
    const h = parseBusinessHours(body.ring_hours, RING_HOURS_WORDS);
    if (!h.ok) throw new ApiError("bad_request", h.error);
    // {} would be "never": a person who wants no calls has Do Not Disturb, with its end time.
    if (h.value && !Object.keys(h.value).length) throw new ApiError("bad_request", HOURS_NO_DAYS);
    patch.ring_hours = h.value;
  }
  if (body.ring_hours_tz !== undefined) {
    if (body.ring_hours_tz === null || body.ring_hours_tz === "") patch.ring_hours_tz = null;
    else if (!validTimeZone(body.ring_hours_tz)) throw new ApiError("bad_request", HOURS_BAD_ZONE);
    else patch.ring_hours_tz = body.ring_hours_tz;
  }
  // Hours are always saved with the zone they were set in, so they never move with the business's.
  if (patch.ring_hours && !patch.ring_hours_tz) throw new ApiError("bad_request", HOURS_NO_ZONE);
  return patch;
}

/** Your own settings, for a screen that has no /token answer to read them from (the portal). */
export async function mySettings(env: Env, req: Request): Promise<Response> {
  const c = await requireCaller(env, req, { needOn: false });
  const row = must(
    await c.admin.from("phone_user_settings").select(SETTINGS_COLUMNS).eq("user_id", c.userId).maybeSingle(),
    "read phone settings",
  ) as SettingsRow | null;
  return ok({ settings: settingsOut(row) });
}

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
      // Forwarding a business line to itself (or to another of the business's numbers, migration
      // 266) would ring the same Dial forever.
      if ((c.ctx.number && cell === c.ctx.number.e164) || (c.ctx.numbers ?? []).includes(cell)) {
        throw new ApiError("bad_request", "That's your business number. Enter your own cell phone.");
      }
      patch.forward_to_cell = cell;
    }
  }
  Object.assign(patch, hoursPatch(body));
  if (body.dnd_cover_user_id !== undefined) patch.dnd_cover_user_id = await coverChoice(c, body.dnd_cover_user_id);

  const nowIso = new Date().toISOString();
  const row = { user_id: c.userId, client_id: c.ctx.client_id, updated_at: nowIso, ...patch };
  let saved = must(
    await c.admin.from("phone_user_settings").upsert(row, { onConflict: "user_id" }).select(SETTINGS_COLUMNS).single(),
    "save phone settings",
  ) as SettingsRow | null;
  // Turning DND on without an end time must not inherit the end of an earlier timed DND that
  // has already passed: the upsert keeps the old dnd_until, and a passed one reads as OFF here
  // and in phone_route_for_number, so the switch did nothing and calls kept ringing. A timer
  // still running is left alone (only a passed one is cleared, and only if it still is).
  if (body.dnd === true && body.dnd_until === undefined && saved?.dnd_until) {
    const until = Date.parse(saved.dnd_until);
    if (Number.isFinite(until) && until <= Date.now()) {
      const cleared = must(
        await c.admin.from("phone_user_settings").update({ dnd_until: null, updated_at: nowIso })
          .eq("user_id", c.userId).lte("dnd_until", new Date().toISOString()).select(SETTINGS_COLUMNS),
        "clear passed dnd_until",
      ) as SettingsRow[] | null;
      if (cleared?.length) saved = cleared[0];
    }
  }
  return ok({ settings: settingsOut(saved) });
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

// The app was renamed My Synergy Phone on 2026-10-01. Builds installed before that still send
// the old codes, so both are accepted, and a row keeps the code the app sent (app_version in its
// context says which build). Drop the two old codes once no installed build sends them.
// ⚠️ DEPLOY ORDER: this Worker goes out BEFORE any renamed extension or app build is installed.
// A Worker without the new codes answers them 400 "Unknown log source.", and those errors are
// lost (SETUP.md section 9).
const LOG_SOURCES = new Set([
  "my-synergy-phone-extension", "my-synergy-phone-mobile",
  "sss-phone-extension", "sss-phone-mobile",
]);
const LOG_SEVERITIES = new Set(["error", "warn", "info"]);
const perUser = new Map<string, { windowStart: number; n: number }>();
const LOG_PER_MINUTE = 30;

/**
 * App errors into app_errors, at the severity the app chose (plan section 14: log_error would
 * demote a chrome-extension:// page to info, so the apps come through here instead).
 *
 * A report from the Chrome extension carries no direct identifier (src/logPrivacy.ts,
 * DEVIATIONS 64): no client_id and no user_id, but `user_ref` and `client_ref` (keyed
 * pseudonyms), only the context keys the extension is known to send, and emails, numbers,
 * uuids and SIDs redacted from the text. Pseudonymous is not anonymous, so those rows are read
 * only in summary (SETUP.md section 10). A report from the mobile app is stored as it always was.
 */
export async function log(env: Env, req: Request): Promise<Response> {
  const { admin, userId, ctx } = await requireLogin(env, req);
  const body = await readJson(req);
  const source = String(body.source ?? "");
  if (!LOG_SOURCES.has(source)) throw new ApiError("bad_request", "Unknown log source.");
  const severity = LOG_SEVERITIES.has(String(body.severity)) ? String(body.severity) : "error";
  const rawMessage = String(body.message ?? "").trim();
  if (!rawMessage) throw new ApiError("bad_request", "The log message is empty.");

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
  const code = body.code == null ? null : String(body.code);
  const appVersion = String(body.app_version ?? "");
  const userAgent = (req.headers.get("user-agent") ?? "").slice(0, 400) || null;
  const row: Record<string, unknown> = EXTENSION_LOG_SOURCES.has(source)
    ? {
      source,
      severity,
      code: code == null ? null : scrubText(code, 100),
      message: scrubText(rawMessage, 4000),
      url: null,
      user_agent: userAgent,
      client_id: null,
      context: {
        ...extensionContext(context),
        app_version: scrubText(appVersion, 40) || null,
        ...(await extensionRefs(env, userId, ctx?.client_id ?? null)),
      },
    }
    : {
      source,
      severity,
      code: code == null ? null : code.slice(0, 100),
      message: rawMessage.slice(0, 4000),
      url: null,
      user_agent: userAgent,
      client_id: ctx?.client_id ?? null,
      context: { ...context, app_version: appVersion.slice(0, 40) || null, user_id: userId },
    };
  const { error } = await admin.from("app_errors").insert(row);
  if (error) throw new ApiError("internal", "The error report couldn't be saved.");
  return ok();
}

/**
 * The extension report's `user_ref` and `client_ref`. Without a usable LOG_PSEUDONYM_KEY, or if
 * the hash fails, there are none at all (never the raw ids, never an unkeyed hash) and the
 * report is still saved; the gap is logged once per isolate, with no id in it.
 */
async function extensionRefs(env: Env, userId: string, clientId: string | null): Promise<Record<string, string>> {
  if (!pseudonymKey(env.LOG_PSEUDONYM_KEY)) {
    await logFault({
      code: "log_pseudonym_key_missing",
      severity: "warn",
      once: true,
      message: "LOG_PSEUDONYM_KEY is unset or shorter than 32 characters: Chrome extension error reports are saved without user_ref or client_ref.",
    });
    return {};
  }
  try {
    return await reportRefs(env.LOG_PSEUDONYM_KEY, userId, clientId);
  } catch (e) {
    await logFault({ code: "log_pseudonym_failed", once: true, message: `Couldn't compute the log pseudonyms: ${(e as Error)?.message ?? e}` });
    return {};
  }
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
