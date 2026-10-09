// The Worker's bindings, and the Deno.env shim the shared edge-function modules need.
//
// Every secret keeps the SAME NAME it has on the Supabase edge functions, so the shared files
// (supabase/functions/_shared/smsSend.ts → twilioSms.ts, logError.ts) read them unchanged
// through Deno.env.get. The full list, with what each one is for, is in README.md.

import type { WebhookAccount } from "../../../supabase/functions/_shared/twilioAccount.ts";

export interface Env {
  // ── vars (wrangler.jsonc) ──────────────────────────────────────────────────────────
  PUBLIC_BASE_URL: string;
  EMERGENCY_MODE?: string;
  DAILY_MINUTE_CAP?: string;
  EXTENSION_ORIGINS?: string;
  /**
   * Exactly "on" lets cron/usageCharge.ts charge armed calls and texts to the wallet, and lets
   * wallet.ts refuse an outbound call below the floor. Anything else: nothing is charged and
   * nothing is refused (costs are still recorded, see PHONE_USAGE_COST_CAPTURE).
   */
  PHONE_USAGE_METERS?: string;
  /**
   * Anything but "off" (unset included) records what every call and text cost at Twilio, and
   * what it WOULD have charged at the current markup, in usage_charges as `shadow` rows, while
   * nothing is charged. Carolyn compares those numbers before arming.
   */
  PHONE_USAGE_COST_CAPTURE?: string;
  VOICEMAIL_RETENTION_DAYS?: string;
  /** "on" adds Twilio transcription to voicemail (<Record transcribe>). Anything else: off. */
  TRANSCRIBE?: string;
  /**
   * Call recording's kill switch (src/recording.ts). Exactly "on" lets a business that turned
   * recording on have its calls announced and recorded. Anything else: no announcement, no
   * recording, whatever the business chose. Recordings already made are still played and expired.
   */
  CALL_RECORDING?: string;
  /**
   * Exactly "on" transcribes and summarises recorded calls (cron/transcribe.ts, Workers AI and the
   * phone-call-summary edge function), for businesses that left transcripts on. Anything else: off.
   */
  CALL_TRANSCRIBE?: string;

  // ── Supabase ───────────────────────────────────────────────────────────────────────
  SUPABASE_URL?: string;
  /** The Worker's own Supabase secret key, under the name the shared code reads. */
  SUPABASE_SERVICE_ROLE_KEY?: string;
  /** Only if the project still signs logins with the legacy HS256 secret. */
  SUPABASE_JWT_SECRET?: string;

  // ── Twilio ─────────────────────────────────────────────────────────────────────────
  TWILIO_ACCOUNT_SID?: string;
  /**
   * Signature checks. Twilio's API cannot hand this out, so it may be missing: then the Worker
   * accepts Twilio webhooks on the ?key= secret alone and logs a warning once per isolate.
   */
  TWILIO_AUTH_TOKEN?: string;
  /** API key pair: signs Access Tokens, and authenticates every REST call. */
  TWILIO_API_KEY?: string;
  TWILIO_API_SECRET?: string;
  TWILIO_TWIML_APP_SID?: string;
  /** The setup-test TwiML App that answers with <Echo/>. */
  TWILIO_ECHO_APP_SID?: string;
  /**
   * Workstream 2's switch, the same name and meaning as the edge secret: exactly "on" or "manual"
   * lets a builder's own Twilio sub-account (migration 292's twilio_accounts) sign its webhooks and,
   * from phase 5, carry its calls ("manual" differs only on the edge, where no sub-account is made
   * by itself). Anything else (unset included): everything is the parent account in the TWILIO_*
   * values above and nothing is looked up, which is how the Worker ran before it.
   */
  TWILIO_SUBACCOUNTS?: string;
  /**
   * NOT A VAR. Set by the router on the Env a verified Twilio webhook's handler gets, only while
   * TWILIO_SUBACCOUNTS is "on" or "manual": the account the webhook came from (src/twilioAccount.ts webhookEnv),
   * so a handler can refuse a tenant in another account. An object, so the Deno.env shim (strings
   * only) never exposes it.
   */
  TWILIO_WEBHOOK_ACCOUNT?: WebhookAccount;
  /**
   * The iPhone push credentials (accessToken.ts pushCredentialFor), both with Sandbox unticked:
   * _DEV from the development bundle id's VoIP certificate, _PROD from the store bundle id's.
   */
  TWILIO_PUSH_CREDENTIAL_APNS_DEV?: string;
  TWILIO_PUSH_CREDENTIAL_APNS_PROD?: string;
  TWILIO_PUSH_CREDENTIAL_FCM?: string;

  // ── Our own webhook secrets ───────────────────────────────────────────────────────
  PHONE_WEBHOOK_SECRET?: string;
  /** The ?key= on the sms-status callback URL texts carry (same value as the edge functions). */
  SMS_INBOUND_SECRET?: string;
  PUSH_WEBHOOK_SECRET?: string;
  /**
   * The HMAC key for the Chrome extension's error reports (POST /log, src/logPrivacy.ts): they
   * store a keyed pseudonym of the person and the business instead of their ids. 32 characters
   * or more; unset or shorter, those reports are saved with no pseudonym at all.
   */
  LOG_PSEUDONYM_KEY?: string;

  // ── Text alerts ───────────────────────────────────────────────────────────────────
  /** The Firebase service account JSON, whole. */
  FCM_SERVICE_ACCOUNT_JSON?: string;
  /** The APNs .p8 auth key (PEM text): Team Scoped, enabled for Production (routes/push.ts APNS_HOST). */
  APNS_KEY_P8?: string;
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  /** The apns-topic for devices registered with build_type "prod": the App Store bundle id. */
  APNS_BUNDLE_ID?: string;
  /**
   * The apns-topic for build_type "dev": the development bundle id. Unset: APNS_BUNDLE_ID + ".dev",
   * the app's own rule for its development builds (an APNS_BUNDLE_ID already ending in ".dev" is
   * used as it is). Set it anyway: an older Worker sends dev devices APNS_BUNDLE_ID itself, so with
   * both set, the order of setting secrets and deploying doesn't matter.
   */
  APNS_BUNDLE_ID_DEV?: string;

  // ── bindings ──────────────────────────────────────────────────────────────────────
  CF_VERSION_METADATA?: { id: string; tag?: string; timestamp?: string };
  /** Workers AI: speech to text for recorded calls (Deepgram nova-3, cron/transcribe.ts). */
  AI?: Ai;
}

/** The slice of ExecutionContext the handlers use, so tests can pass a plain object. */
export interface Ctx {
  waitUntil(p: Promise<unknown>): void;
}

/**
 * Deno.env.get over the Worker's env, for the shared modules.
 *
 * Installed on every request rather than once: the env object is the same for the life of an
 * isolate in production, but tests build a fresh one per case, and re-pointing a getter costs
 * nothing. Only string values are exposed; bindings are not env vars.
 */
export function installDenoShim(env: Env): void {
  const source = env as unknown as Record<string, unknown>;
  const get = (k: string): string | undefined => {
    const v = source[k];
    return typeof v === "string" ? v : undefined;
  };
  const g = globalThis as unknown as { Deno?: { env?: { get?: unknown } } };
  if (g.Deno && typeof g.Deno === "object" && g.Deno.env) {
    g.Deno.env.get = get;
    return;
  }
  g.Deno = { env: { get } };
}

/** A string var as an integer, with a floor and a fallback for blank or garbage values. */
export function intVar(v: string | undefined, fallback: number, min = 0): number {
  const n = Number.parseInt(String(v ?? "").trim(), 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

/** PUBLIC_BASE_URL without a trailing slash. */
export function baseUrl(env: Env): string {
  return String(env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
}

export const WORKER_VERSION = "0.1.0";
