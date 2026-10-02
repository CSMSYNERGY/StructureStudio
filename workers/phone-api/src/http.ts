// Responses, the stable error codes, and CORS.
//
// Every app endpoint answers {ok:true, ...} or {ok:false, error:{code, message}}. `code` is one
// of the SPEC's stable strings (clients switch on it); `message` is plain English a person can
// read on the screen, never a Postgres or Twilio string.

import type { Env } from "./env";

export type ErrorCode =
  | "unauthorized"
  | "no_phone_access"
  | "phone_off"
  | "retired_device"
  | "not_your_customer"
  | "no_consent"
  | "opted_out"
  | "number_not_registered"
  | "no_number"
  | "emergency_blocked"
  | "wallet_empty"
  | "minute_cap"
  | "not_found"
  | "bad_request"
  | "twilio_error"
  | "internal";

/** Default wording per code, for refusals that have nothing more specific to say. */
export const ERROR_TEXT: Record<ErrorCode, string> = {
  unauthorized: "Please sign in again.",
  no_phone_access: "Your account doesn't have phone access. Ask your owner to turn it on.",
  phone_off: "My Synergy Phone isn't switched on for your business yet.",
  retired_device: "This device was signed out. Please sign in again.",
  not_your_customer: "You can only text your own customers.",
  no_consent: "This customer hasn't agreed to texts yet.",
  opted_out: "This customer asked not to be texted (STOP).",
  number_not_registered: "Your texting number isn't registered yet.",
  no_number: "Your business doesn't have a phone number yet.",
  emergency_blocked: "For emergencies, call 911 from your cell phone.",
  // Kept identical to wallet.ts WALLET_WORDS.empty (not imported: this file is a leaf).
  wallet_empty: "Your wallet is empty. Add funds in Structure Studio under Settings, Billing.",
  minute_cap: "Today's calling limit is reached. It resets tomorrow.",
  not_found: "That wasn't found.",
  bad_request: "Something about that request wasn't right.",
  twilio_error: "The phone service had a problem. Please try again.",
  internal: "Something went wrong. Please try again.",
};

const STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  no_phone_access: 403,
  phone_off: 403,
  retired_device: 403,
  not_your_customer: 403,
  no_consent: 409,
  opted_out: 409,
  number_not_registered: 409,
  no_number: 409,
  emergency_blocked: 403,
  wallet_empty: 402,
  minute_cap: 429,
  not_found: 404,
  bad_request: 400,
  twilio_error: 502,
  internal: 500,
};

/**
 * Thrown by handlers for a deliberate refusal; the router turns it into the JSON error.
 * `extra` rides beside `error` in the body, for facts that stay true whatever the refusal says
 * (hold and warm transfer send `held` and `call_id`: phone-core's refusalHeld reads them). It
 * can never replace `ok` or `error`.
 */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly extra: Record<string, unknown> | null;
  constructor(code: ErrorCode, message?: string, status?: number, extra?: Record<string, unknown>) {
    super(message ?? ERROR_TEXT[code]);
    this.name = "ApiError";
    this.code = code;
    this.status = status ?? STATUS[code];
    this.extra = extra ?? null;
  }
}

export function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export function ok(body: Record<string, unknown> = {}): Response {
  return json({ ok: true, ...body });
}

export function errorResponse(e: ApiError): Response {
  return json({ ...(e.extra ?? {}), ok: false, error: { code: e.code, message: e.message } }, e.status);
}

export function twiml(xml: string, status = 200): Response {
  return new Response(xml, {
    status,
    headers: { "content-type": "text/xml; charset=utf-8", "cache-control": "no-store" },
  });
}

export function noContent(): Response {
  return new Response(null, { status: 204 });
}

/** Parse a JSON body into a plain object. A malformed or non-object body is a bad_request. */
export async function readJson(req: Request): Promise<Record<string, unknown>> {
  let raw: unknown;
  try {
    const text = await req.text();
    raw = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError("bad_request", "The request body isn't valid JSON.");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ApiError("bad_request", "The request body must be a JSON object.");
  }
  return raw as Record<string, unknown>;
}

// ── CORS ────────────────────────────────────────────────────────────────────────────
//
// The mobile app sends no Origin and needs nothing here. The extension's pages send
// chrome-extension://<id>, and only the ids in EXTENSION_ORIGINS are allowed. The portal may
// read through the Worker too, from the two hosts that exist in DNS (app. and beta., see
// _shared/customerPortalUrl.ts), plus the beta-2-0 preview host.
//
// Nothing here is authentication: every endpoint still checks the bearer token. The list only
// stops some other website's JavaScript from reading the responses with a stolen token in hand.

export const PORTAL_ORIGINS = [
  "https://app.structurestudiosuite.com",
  "https://beta.structurestudiosuite.com",
  "https://beta-2-0.structurestudiosuite.com",
];

export function allowedOrigin(env: Env, origin: string | null): string | null {
  if (!origin) return null;
  if (PORTAL_ORIGINS.includes(origin)) return origin;
  const ext = String(env.EXTENSION_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.startsWith("chrome-extension://") ? s.replace(/\/+$/, "") : `chrome-extension://${s}`));
  return ext.includes(origin) ? origin : null;
}

export function corsHeaders(allowed: string | null): Record<string, string> {
  if (!allowed) return { Vary: "Origin" };
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type, x-sss-client",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

/** Copy a response with CORS headers added (Twilio and cron paths never go through this). */
export function withCors(res: Response, allowed: string | null): Response {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders(allowed))) h.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

/** Constant-time string compare (length leaks, content does not). */
export function safeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** A path segment, decoded. A malformed %-escape is the caller's mistake, not a fault. */
export function pathParam(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new ApiError("bad_request", "That address isn't valid.");
  }
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CALL_SID_RE = /^CA[0-9a-f]{32}$/;
