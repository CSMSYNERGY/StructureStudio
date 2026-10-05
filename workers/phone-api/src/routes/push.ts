// POST /push/text: a database webhook on new inbound sms_messages rows (header x-push-secret).
// POST /push/email: the same for a customer's email (email_inbound, migration 267), ids only.
//
// Answers 204 at once and sends in the background. Sends a NORMAL (not VoIP) alert to the
// devices of the people who own the text (plan section 7):
//   • the contact's assigned owner, when there is one;
//   • otherwise everyone with phone access who can see that contact;
//   • for an unknown number, everyone with phone access and contacts view or edit.
// An email goes to the same people as a text from its contact would. It only ever has a contact
// (its own, or its design's): mail from someone who isn't one alerts nobody, as the apps' lists
// never show it either.
// Android gets FCM HTTP v1 NOTIFICATION messages (Twilio's SDK owns the app's one Firebase
// listener and drops anything that is not a call, so a data-only message would vanish; a
// notification message is shown by Android itself). iPhone gets APNs alerts.
// Twilio's push credentials cannot send these, so the Worker holds its own: a Firebase service
// account and an APNs .p8 key. Either one unset → that platform is skipped and logged, once an
// hour per isolate, never an error per text.

import type { Ctx, Env } from "../env";
import { adminClient, must, type Admin } from "../db";
import { b64urlEncode, b64urlEncodeString, pemToDer } from "../b64";
import { ApiError, UUID_RE, noContent, safeEqual } from "../http";
import { phoneDigits } from "../identity";
import { logFault } from "../log";
import { contactsLevelOf, phoneLevelOf } from "../scope";
import { senderVerifiedFrom } from "../../../../supabase/functions/_shared/crmFeed.ts";

interface SmsRecord {
  id: string;
  client_id: string;
  contact_id: string | null;
  direction: string;
  from_number: string | null;
  body: string | null;
  num_media?: number | null;
}

interface Device {
  id: string;
  user_id: string;
  platform: string;
  build_type: string;
  push_token: string;
  push_kind: "fcm" | "apns";
}

/** A received email, as deliverEmail reads it back. Never the body: an alert shows the subject. */
interface EmailRow {
  id: string;
  client_id: string;
  contact_id: string | null;
  short_code: string | null;
  subject: string | null;
  spam_verdict: string | null;
}

export interface Alert {
  title: string;
  body: string;
  threadKey: string;
  messageId: string;
  /** What arrived, sent to the apps as `type`. Unset is a text, as every alert was before email. */
  kind?: "sms" | "email";
}

/** The database's own secret (Vault 'sss_phone_push_secret'), the same for texts and email. */
function checkPushSecret(env: Env, req: Request): void {
  const secret = env.PUSH_WEBHOOK_SECRET ?? "";
  if (!secret || !safeEqual(req.headers.get("x-push-secret") ?? "", secret)) {
    throw new ApiError("unauthorized", "Not allowed.");
  }
}

async function webhookPayload<T>(req: Request): Promise<{ type?: string; table?: string; record?: T } | null> {
  try {
    return await req.json();
  } catch {
    throw new ApiError("bad_request", "Expected a database webhook payload.");
  }
}

export async function pushText(env: Env, ec: Ctx, req: Request): Promise<Response> {
  checkPushSecret(env, req);
  const payload = await webhookPayload<SmsRecord>(req);
  const rec = payload?.record;
  if (payload?.type === "INSERT" && payload.table === "sms_messages" && rec?.direction === "in" && rec.client_id) {
    ec.waitUntil(deliver(env, rec).catch((e) => logFault({
      code: "push_text_failed", clientId: rec.client_id, message: `text alert failed: ${(e as Error).message}`,
    })));
  }
  return noContent();
}

/** email-inbound's client_id for mail it could not place with any business (emailInbound.ts). */
const UNATTRIBUTED = "__unattributed__";

/**
 * The trigger (migration 267) sends {id, client_id} and nothing else, so no email's words sit in
 * pg_net's queue. Only those two are read here, and only to find the row again: deliverEmail
 * reads everything it shows from the table.
 */
export async function pushEmail(env: Env, ec: Ctx, req: Request): Promise<Response> {
  checkPushSecret(env, req);
  const payload = await webhookPayload<{ id?: unknown; client_id?: unknown }>(req);
  const id = typeof payload?.record?.id === "string" ? payload.record.id : "";
  const clientId = typeof payload?.record?.client_id === "string" ? payload.record.client_id : "";
  if (payload?.type === "INSERT" && payload.table === "email_inbound" && UUID_RE.test(id)
      && clientId && clientId !== UNATTRIBUTED) {
    ec.waitUntil(deliverEmail(env, id, clientId).catch((e) => logFault({
      code: "push_email_failed", clientId, message: `email alert failed: ${(e as Error).message}`,
    })));
  }
  return noContent();
}

/** Who owns this inbound text (plan section 7). `contactFound` is false when the contact id
 *  names no contact of this business. */
export async function textOwners(
  admin: Admin,
  rec: Pick<SmsRecord, "client_id" | "contact_id">,
): Promise<{ owners: string[]; contactName: string | null; contactFound: boolean }> {
  type ContactOwner = { name: string | null; owner_user_id: string | null };
  const contact: ContactOwner | null = rec.contact_id
    ? must(
      await admin.from("crm_contacts").select("name, owner_user_id").eq("id", rec.contact_id).eq("client_id", rec.client_id).maybeSingle(),
      "read contact",
    ) as ContactOwner | null
    : null;
  const users = (must(
    await admin.from("client_users").select("user_id, role, title, access").eq("client_id", rec.client_id),
    "read team",
  ) as { user_id: string; role: string | null; title: string | null; access: Record<string, unknown> | null }[] | null) ?? [];
  const withPhone = users.filter((u) => phoneLevelOf(u) !== "none");

  if (contact?.owner_user_id) {
    const owner = withPhone.find((u) => u.user_id === contact!.owner_user_id);
    return { owners: owner ? [owner.user_id] : [], contactName: contact.name ?? null, contactFound: true };
  }
  const owners: string[] = [];
  const narrowed: string[] = [];
  for (const u of withPhone) {
    const lvl = contactsLevelOf(u);
    if (lvl === "view" || lvl === "edit") owners.push(u.user_id);
    else if (lvl === "own" && rec.contact_id) narrowed.push(u.user_id);
  }
  // Own-scoped people see an unowned contact only if they follow it: the same predicate as RLS.
  if (narrowed.length && rec.contact_id) {
    const checks = await Promise.all(narrowed.map((uid) =>
      admin.rpc("crm_visible_contact_ids", { p_client_id: rec.client_id, p_user_id: uid, p_ids: [rec.contact_id] })));
    checks.forEach((r, i) => {
      if (!r.error && Array.isArray(r.data) && r.data.map(String).includes(String(rec.contact_id))) owners.push(narrowed[i]);
    });
  }
  return { owners, contactName: contact?.name ?? null, contactFound: contact !== null };
}

function formatNumber(e164: string | null): string {
  const d = phoneDigits(e164);
  return d ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : (e164 ?? "Unknown number");
}

/** At most `max` characters, the last three of them "..." when it was cut. Never cuts an emoji
 *  in half (a lone surrogate is not valid text to Google or Apple). */
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 3);
  return `${/[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut}...`;
}

async function phoneIsOn(admin: Admin, clientId: string): Promise<boolean> {
  const cs = must(
    await admin.from("client_settings").select("phone_status").eq("client_id", clientId).maybeSingle(),
    "read phone switch",
  ) as { phone_status?: string } | null;
  return cs?.phone_status === "on";
}

async function deliver(env: Env, rec: SmsRecord): Promise<void> {
  const admin = adminClient(env);
  if (!(await phoneIsOn(admin, rec.client_id))) return;

  const { owners, contactName } = await textOwners(admin, rec);
  const body = String(rec.body ?? "").trim();
  await alertDevices(env, admin, owners, {
    title: contactName || formatNumber(rec.from_number),
    body: body ? clip(body, 140) : (Number(rec.num_media) > 0 ? "Photo received" : "New text"),
    threadKey: rec.contact_id ?? `n:${rec.from_number ?? ""}`,
    messageId: rec.id,
  });
}

/**
 * A customer's email, the alert reading "<contact>" over "Email: <subject>" (the app's own
 * foreground alert, threads.ts lastMessageText), never any of the body. A contact with no name
 * is "New email": the sender's own name or address would go through Google and Apple too, and
 * the privacy page promises only the contact's name and the subject. Nothing is sent when:
 *   • the row isn't this business's (the payload names a row; it never vouches for one);
 *   • neither the row nor its design names a contact of this business (the same rule as 261's
 *     live updates: no contact, no conversation to open);
 *   • the provider said the sender failed SPF, DKIM or DMARC or was spam. A forged "From:" must
 *     never ring the team's phones. No verdict at all is unknown, not failed, and still alerts,
 *     as the thread shows such a reply without its "Couldn't confirm this came from" line;
 *   • the business's phone is off.
 */
async function deliverEmail(env: Env, id: string, clientId: string): Promise<void> {
  const admin = adminClient(env);
  const row = must(
    await admin.from("email_inbound")
      .select("id, client_id, contact_id, short_code, subject, spam_verdict")
      .eq("id", id).eq("client_id", clientId).maybeSingle(),
    "read received email",
  ) as EmailRow | null;
  if (!row) return;
  if (senderVerifiedFrom(row.spam_verdict) === false) return;

  let contactId = row.contact_id;
  if (!contactId && row.short_code) {
    const design = must(
      await admin.from("designs").select("contact_id").eq("client_id", row.client_id).eq("short_code", row.short_code).maybeSingle(),
      "read design",
    ) as { contact_id: string | null } | null;
    contactId = design?.contact_id ?? null;
  }
  if (!contactId) return;
  if (!(await phoneIsOn(admin, row.client_id))) return;

  const { owners, contactName, contactFound } = await textOwners(admin, { client_id: row.client_id, contact_id: contactId });
  if (!contactFound) return;
  const subject = String(row.subject ?? "").replace(/\s+/g, " ").trim();
  await alertDevices(env, admin, owners, {
    title: contactName?.trim() || "New email",
    body: clip(`Email: ${subject || "(no subject)"}`, 140),
    threadKey: contactId,
    messageId: row.id,
    kind: "email",
  });
}

/** Sends one alert to every device these people have a push token on, forgetting the tokens
 *  Google or Apple say are gone. */
async function alertDevices(env: Env, admin: Admin, owners: string[], alert: Alert): Promise<void> {
  if (!owners.length) return;
  const devices = (must(
    await admin.from("phone_devices").select("id, user_id, platform, build_type, push_token, push_kind")
      .in("user_id", owners).not("push_token", "is", null),
    "read devices",
  ) as Device[] | null) ?? [];
  if (!devices.length) return;

  const results = await Promise.allSettled(devices.map((d): Promise<SendResult> =>
    d.push_kind === "fcm" ? sendFcm(env, d.push_token, alert)
      : d.push_kind === "apns" ? sendApns(env, d.push_token, d.build_type === "dev" ? "dev" : "prod", alert)
      : Promise.resolve("skipped")));
  const dead: string[] = [];
  const faults: Promise<void>[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      if (r.value === "unregistered") dead.push(devices[i].id);
      return;
    }
    // One device's failure never stops the others (allSettled), but it must not vanish either:
    // a Google token exchange that failed, or anything else a sender didn't catch, lands here.
    faults.push(logFault({
      code: `push_${devices[i].push_kind === "apns" ? "apns" : "fcm"}_threw`, throttleMs: 10 * 60_000,
      message: `A ${devices[i].platform} alert threw: ${String((r.reason as Error)?.message ?? r.reason).slice(0, 300)}`,
    }));
  });
  await Promise.all(faults);
  if (dead.length) await admin.from("phone_devices").delete().in("id", dead);
}

// ── FCM HTTP v1 ─────────────────────────────────────────────────────────────────────

type SendResult = "sent" | "unregistered" | "skipped" | "failed";

let fcmToken: { value: string; exp: number; account: string } | null = null;

async function signRs256(pem: string, claims: Record<string, unknown>): Promise<string> {
  const key = await crypto.subtle.importKey("pkcs8", pemToDer(pem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const input = `${b64urlEncodeString(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64urlEncodeString(JSON.stringify(claims))}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input));
  return `${input}.${b64urlEncode(sig)}`;
}

async function fcmAccessToken(sa: { client_email: string; private_key: string; token_uri?: string }): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (fcmToken && fcmToken.account === sa.client_email && fcmToken.exp - 60 > now) return fcmToken.value;
  const aud = sa.token_uri || "https://oauth2.googleapis.com/token";
  const assertion = await signRs256(sa.private_key, {
    iss: sa.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging", aud, iat: now, exp: now + 3600,
  });
  const res = await fetch(aud, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
  });
  if (!res.ok) throw new Error(`Google token exchange failed (HTTP ${res.status})`);
  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new Error("Google token exchange returned no token");
  fcmToken = { value: body.access_token, exp: now + (Number(body.expires_in) || 3600), account: sa.client_email };
  return body.access_token;
}

export async function sendFcm(env: Env, token: string, a: Alert): Promise<SendResult> {
  if (!env.FCM_SERVICE_ACCOUNT_JSON) {
    await logFault({ code: "push_fcm_not_configured", severity: "info", throttleMs: 3_600_000, message: "FCM_SERVICE_ACCOUNT_JSON is not set; Android text and email alerts are skipped." });
    return "skipped";
  }
  let sa: { client_email: string; private_key: string; project_id: string; token_uri?: string };
  try {
    sa = JSON.parse(env.FCM_SERVICE_ACCOUNT_JSON);
  } catch {
    await logFault({ code: "push_fcm_bad_config", throttleMs: 3_600_000, message: "FCM_SERVICE_ACCOUNT_JSON is not valid JSON." });
    return "skipped";
  }
  const access = await fcmAccessToken(sa);
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(sa.project_id)}/messages:send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        token,
        notification: { title: a.title, body: a.body },
        data: { type: a.kind ?? "sms", thread_key: a.threadKey, message_id: a.messageId },
        android: { priority: "high", collapse_key: a.threadKey.slice(0, 64), notification: { tag: a.threadKey, channel_id: "texts" } },
      },
    }),
  });
  if (res.ok) return "sent";
  if (res.status === 404) return "unregistered";
  let status = "";
  try {
    status = String(((await res.json()) as { error?: { status?: string } })?.error?.status ?? "");
  } catch { /* no body */ }
  if (status === "NOT_FOUND" || status === "UNREGISTERED") return "unregistered";
  await logFault({ code: "push_fcm_failed", throttleMs: 60_000, message: `FCM send failed (HTTP ${res.status} ${status}).` });
  return "failed";
}

// ── APNs ────────────────────────────────────────────────────────────────────────────

/**
 * Every iPhone alert goes to Apple's PRODUCTION host, whatever the device's build_type. A token's
 * APNs environment comes from the provisioning profile the build was signed with, not from the
 * build's entitlements file or its build_type: Xcode sets aps-environment from the profile, and
 * only a development profile gives "development" (sandbox). Every iPhone build of this app comes
 * from EAS, which signs with distribution profiles only: ad hoc for the development and preview
 * profiles (distribution "internal"), App Store for production. So every token, the dev client's
 * included, is a production token, and api.sandbox.push.apple.com would answer BadDeviceToken
 * to all of them. build_type still picks the topic (apnsTopic), since a development build has
 * its own bundle id. A build signed with a development profile (run from Xcode on a Mac) is the
 * one thing this can't reach (DEVIATIONS 75).
 */
export const APNS_HOST = "https://api.push.apple.com";

/** A development build's bundle id is the store build's plus this (the app's own rule, app.config.ts). */
const DEV_BUNDLE_SUFFIX = ".dev";

/** Apple accepts a provider token for up to an hour; a fresh one is signed after this long. */
const APNS_TOKEN_LIFE_S = 50 * 60;

/** A secret as set, without the newline a pasted or piped value tends to bring along. */
function secret(v: string | undefined): string {
  return String(v ?? "").trim();
}

/**
 * The provider token (an ES256 JWT) every send carries. Apple refuses one that is more than an
 * hour old, and answers TooManyProviderTokenUpdates to a sender that changes it more often than
 * every 20 minutes, so ONE is kept per isolate and replaced after 50 minutes. What is kept is the
 * promise, so a fan-out to several iPhones on a cold isolate signs once rather than once per
 * phone. A failure is not kept: a corrected key works on the next send.
 */
let apnsJwt: { value: Promise<string>; iat: number; key: string } | null = null;

function apnsProviderToken(env: Env): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const kid = secret(env.APNS_KEY_ID);
  const iss = secret(env.APNS_TEAM_ID);
  const cacheKey = `${iss}/${kid}`;
  if (apnsJwt && apnsJwt.key === cacheKey && now - apnsJwt.iat < APNS_TOKEN_LIFE_S) return apnsJwt.value;
  const value = (async () => {
    const key = await crypto.subtle.importKey("pkcs8", pemToDer(env.APNS_KEY_P8!), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    const input = `${b64urlEncodeString(JSON.stringify({ alg: "ES256", kid }))}.${b64urlEncodeString(JSON.stringify({ iss, iat: now }))}`;
    // WebCrypto's ECDSA signature is r||s, 64 bytes: the JWS form, no DER to unwrap.
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(input));
    return `${input}.${b64urlEncode(sig)}`;
  })();
  const entry = { value, iat: now, key: cacheKey };
  apnsJwt = entry;
  value.catch(() => {
    if (apnsJwt === entry) apnsJwt = null;
  });
  return value;
}

/** Tests only: forget the cached Google access token and APNs provider token. */
export function resetPushTokens(): void {
  fcmToken = null;
  apnsJwt = null;
}

/**
 * The apns-topic (the app's bundle id) for a device's build type:
 *   prod (preview, TestFlight, App Store) → APNS_BUNDLE_ID.
 *   dev  (the development client)         → APNS_BUNDLE_ID_DEV when set, otherwise APNS_BUNDLE_ID
 *                                           with ".dev" added, the app's own rule for its
 *                                           development id. An APNS_BUNDLE_ID that already ends
 *                                           in ".dev" is used as it is (the old plan, where every
 *                                           build shared the .dev id).
 * A prod device never falls back to a dev topic. Bundle ids are secrets, not vars, so they stay
 * out of this public repo (plan D7). null: no topic for this build type.
 */
export function apnsTopic(env: Env, buildType: "dev" | "prod"): string | null {
  const store = secret(env.APNS_BUNDLE_ID);
  if (buildType === "prod") return store || null;
  const dev = secret(env.APNS_BUNDLE_ID_DEV);
  if (dev) return dev;
  if (!store) return null;
  return store.endsWith(DEV_BUNDLE_SUFFIX) ? store : `${store}${DEV_BUNDLE_SUFFIX}`;
}

/** The secrets a send to this build type still needs, by name. Empty: it can send. */
export function apnsMissing(env: Env, buildType: "dev" | "prod"): string[] {
  const missing = (["APNS_KEY_P8", "APNS_KEY_ID", "APNS_TEAM_ID"] as const).filter((k) => !secret(env[k]));
  return apnsTopic(env, buildType) ? missing : [...missing, "APNS_BUNDLE_ID"];
}

/**
 * One alert to one iPhone. `buildType` is the device row's build_type: it picks the topic, never
 * the host (APNS_HOST says why). Never throws for anything Apple or the configuration does: every
 * outcome is a SendResult, so one iPhone never costs another its alert.
 */
export async function sendApns(env: Env, token: string, buildType: "dev" | "prod", a: Alert): Promise<SendResult> {
  const missing = apnsMissing(env, buildType);
  if (missing.length) {
    await logFault({
      code: "push_apns_not_configured", severity: "warn", throttleMs: 3_600_000,
      message: `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set: iPhone text and email alerts are skipped (first seen for a ${buildType} build).`,
    });
    return "skipped";
  }
  const topic = apnsTopic(env, buildType)!;

  let providerToken: string;
  try {
    providerToken = await apnsProviderToken(env);
  } catch (e) {
    await logFault({
      code: "push_apns_bad_key", throttleMs: 3_600_000,
      message: `APNS_KEY_P8 couldn't sign (${String((e as Error)?.message ?? e).slice(0, 200)}): iPhone alerts are skipped. It must be the whole .p8 file Apple gave out.`,
    });
    return "skipped";
  }

  const host = APNS_HOST;
  let res: Response;
  try {
    res = await fetch(`${host}/3/device/${encodeURIComponent(token)}`, {
      method: "POST",
      headers: {
        authorization: `bearer ${providerToken}`,
        "apns-topic": topic,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "apns-collapse-id": a.threadKey.slice(0, 64),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        aps: { alert: { title: a.title, body: a.body }, sound: "default", "thread-id": a.threadKey },
        // expo-notifications hands the app a remote notification's `body` object as its data
        // (iOS, NotificationRecords.serializedNotificationData), and nothing else of the
        // payload: without it, tapping an alert could not open its thread. The same keys stay
        // at the top level for anything that reads the raw payload.
        body: { type: a.kind ?? "sms", thread_key: a.threadKey, message_id: a.messageId },
        type: a.kind ?? "sms", thread_key: a.threadKey, message_id: a.messageId,
      }),
    });
  } catch (e) {
    // Apple speaks HTTP/2 only (DEVIATIONS 28). A Worker that can't reach it fails here, and
    // this row is what says so.
    await logFault({
      code: "push_apns_unreachable", throttleMs: 10 * 60_000,
      message: `Couldn't reach ${host} (${String((e as Error)?.message ?? e).slice(0, 200)}).`,
    });
    return "failed";
  }
  if (res.ok) return "sent";
  let reason = "";
  try {
    reason = String(((await res.json()) as { reason?: string })?.reason ?? "");
  } catch { /* no body */ }

  // 410 (Unregistered, ExpiredToken): the app is gone from that phone, or its token expired.
  if (res.status === 410 || reason === "Unregistered" || reason === "ExpiredToken") return "unregistered";
  if (reason === "BadDeviceToken") {
    // Not a token the production host knows: a sandbox token (a build signed with a development
    // profile, which only Xcode makes; every EAS build is production, APNS_HOST) or a damaged
    // one. Neither can ever be reached here, so it is forgotten like a dead one (the app saves its
    // token again on its next launch), and logged.
    await logFault({
      code: "push_apns_bad_device_token", severity: "warn", throttleMs: 3_600_000,
      message: `APNs (${host}) refused a ${buildType} build's token (BadDeviceToken); it was forgotten. Every EAS build has a production token, so this is a build signed with a development profile (run from Xcode), which this Worker doesn't send to, or a damaged token.`,
    });
    return "unregistered";
  }
  if (reason === "DeviceTokenNotForTopic" || reason === "TopicDisallowed" || reason === "BadTopic") {
    // Our configuration, not the device: the token is fine, the bundle id we sent is not its app's
    // (or the key may not send to it).
    await logFault({
      code: "push_apns_wrong_topic", throttleMs: 3_600_000,
      message: `APNs refused topic "${topic}" for a ${buildType} build (${reason}). Check ${buildType === "dev" ? "APNS_BUNDLE_ID_DEV (unset: APNS_BUNDLE_ID + \".dev\")" : "APNS_BUNDLE_ID"}, and that the APNs key is Team Scoped (a Topic Specific key only sends to the bundle ids it lists).`,
    });
    return "failed";
  }
  // A token Apple calls expired is signed again on the next send. (Not on InvalidProviderToken:
  // re-signing a wrong key id or team id fixes nothing, and changing tokens too often is its own
  // refusal.)
  if (reason === "ExpiredProviderToken") apnsJwt = null;
  await logFault({
    code: res.status === 403 ? "push_apns_auth_failed" : "push_apns_failed",
    throttleMs: res.status === 403 ? 3_600_000 : 60_000,
    message: res.status !== 403 ? `APNs send failed (HTTP ${res.status} ${reason}).`
      // Apple's keys are made for one environment now (Sandbox or Production). One made for
      // Sandbox signs perfectly and is still refused by the production host, under this reason.
      : reason === "BadEnvironmentKeyIdInToken"
        ? `APNs refused the provider token (HTTP 403 BadEnvironmentKeyIdInToken): the key APNS_KEY_ID names isn't enabled for Production, the only environment this Worker sends to. Create a Team Scoped key for Production in the Apple Developer account and set APNS_KEY_P8 and APNS_KEY_ID to it.`
        : `APNs refused the provider token (HTTP 403 ${reason}). Check that APNS_KEY_ID, APNS_TEAM_ID and APNS_KEY_P8 are one key of one team, and that the key is enabled for Production.`,
  });
  return "failed";
}
