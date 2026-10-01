// phone-api: the My Synergy Phone Worker. Contract: the phone repo's docs/SPEC.md section 3.
//
// Three kinds of traffic, handled differently on purpose:
//   /voice/*    Twilio. ?key= first, always, and X-Twilio-Signature whenever TWILIO_AUTH_TOKEN
//               is set (without it: the key alone, and one warning per isolate). Answers TwiML
//               (or 204). A fault answers 500 with no body, so Twilio falls over to the
//               number's Voice Fallback URL and the caller still reaches voicemail.
//   /push/text  the database webhook (x-push-secret). 204.
//   the rest    the extension and the app: bearer login, JSON {ok, ...}, CORS for the extension
//               and portal origins.
// Every unexpected fault is logged through the shared logEdgeError as edge:phone-api.

import type { Ctx, Env } from "./env";
import { installDenoShim } from "./env";
import { DbError, adminClient } from "./db";
import {
  ApiError, allowedOrigin, corsHeaders, errorResponse, json, noContent, pathParam, twiml, withCors,
} from "./http";
import { logFault } from "./log";
import { verifyTwilioRequest } from "./twilioSignature";
import { afterDial, applyStatus, inbound, outbound, screen, transcription, voicemail } from "./routes/voice";
import { conferenceEvent } from "./conference";
import { token } from "./routes/token";
import { events, transfer, voicemailAudio } from "./routes/calls";
import { hold, resume, warmTransfer } from "./routes/conference";
import { mediaFile } from "./routes/media";
import { sendSms } from "./routes/sms";
import { getThread, listCalls, listThreads, search, team } from "./routes/reads";
import { devices, forgetDevice, health, log, settingsMe, signOutAll, turn } from "./routes/me";
import { createQuickSend, deleteQuickSend, listQuickSends, quickSendUsed, updateQuickSend } from "./routes/quickSends";
import { pushText } from "./routes/push";
import { recordingSweep } from "./cron/sweep";
import { retention } from "./cron/retention";
import { chargeMonthlyLineFees, debitDailyUsage } from "./cron/usageDebit";

export const CRON_SWEEP = "*/15 * * * *";
export const CRON_DAILY = "0 9 * * *";
// The account's free plan has 5 cron triggers in total and 4 are used by other workers, so the
// Worker runs ONE every-minute tick: keep-warm every minute, the sweep on minutes divisible by
// 15, and the daily jobs at 09:00 UTC. The two older strings still dispatch (tests, rollback).
export const CRON_TICK = "* * * * *";

// ── Twilio ──────────────────────────────────────────────────────────────────────────

const VOICE_PATHS = new Set([
  "/voice/outbound", "/voice/inbound", "/voice/after-dial", "/voice/screen", "/voice/status", "/voice/voicemail",
  "/voice/conference", "/voice/transcription",
]);

async function handleTwilio(req: Request, env: Env, ec: Ctx, path: string, t0: number): Promise<Response> {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const check = await verifyTwilioRequest(env, req);
  if (!check.ok) {
    const misconfigured = check.reason === "no_webhook_secret";
    ec.waitUntil(logFault({
      code: `twilio_${check.reason}`,
      // A missing secret is OUR fault and stops every call: an error. A bad key or signature is
      // someone else's request being correctly refused: info, and throttled.
      severity: misconfigured ? "error" : "info",
      message: misconfigured
        ? "Refusing every Twilio request: PHONE_WEBHOOK_SECRET is not set."
        : `Refused a Twilio webhook (${check.reason}) on ${path}.`,
      req,
      throttleMs: misconfigured ? 5 * 60_000 : 60_000,
    }));
    return new Response(misconfigured ? "Service unavailable" : "Forbidden", { status: misconfigured ? 503 : 403 });
  }
  if (!check.signed) {
    // Accepted on ?key= alone because TWILIO_AUTH_TOKEN is unset. A known state, not a fault,
    // but never a silent one: once per isolate.
    ec.waitUntil(logFault({
      code: "twilio_signature_skipped", severity: "warn", once: true, req,
      message: "TWILIO_AUTH_TOKEN is not set: Twilio webhooks are accepted on the ?key= secret alone, without checking X-Twilio-Signature.",
    }));
  }
  const p = check.params;
  const url = new URL(req.url);
  switch (path) {
    case "/voice/outbound":
      return twiml(await outbound(env, ec, p, t0));
    case "/voice/inbound":
      return twiml(await inbound(env, ec, p, t0));
    case "/voice/after-dial":
      return twiml(await afterDial(env, ec, p, url));
    case "/voice/screen":
      return twiml(await screen(env, ec, p, url));
    case "/voice/status":
      // Reply first; the write happens after Twilio has its answer.
      ec.waitUntil(applyStatus(env, p, url, check.signed).catch((e) => logFault({ code: "status_write_failed", message: (e as Error).message, req })));
      return noContent();
    case "/voice/voicemail": {
      const out = voicemail(env, ec, p, url);
      return out.xml ? twiml(out.xml) : noContent();
    }
    case "/voice/conference":
      // Conference status callback (it started, or a participant left). Reply first, act after.
      ec.waitUntil(conferenceEvent(env, p, url, check.signed).catch((e) => logFault({ code: "conference_event_failed", message: (e as Error).message, req })));
      return noContent();
    case "/voice/transcription":
      ec.waitUntil(transcription(env, p, url).catch((e) => logFault({ code: "transcript_write_failed", message: (e as Error).message, req })));
      return noContent();
  }
  return new Response("Not found", { status: 404 });
}

// ── App ─────────────────────────────────────────────────────────────────────────────

type Handler = (req: Request, env: Env, ec: Ctx, m: RegExpExecArray) => Promise<Response> | Response;

const ROUTES: { method: string; re: RegExp; h: Handler }[] = [
  { method: "GET", re: /^\/health$/, h: (r, env) => health(env, new URL(r.url).searchParams.get("warm") === "1") },
  { method: "POST", re: /^\/token$/, h: (r, env, ec) => token(env, ec, r) },
  { method: "GET", re: /^\/voicemails\/([^/]+)\/audio$/, h: (r, env, ec, m) => voicemailAudio(env, ec, r, m[1]) },
  { method: "GET", re: /^\/media\/([^/]+)\/([^/]+)$/, h: (r, env, _ec, m) => mediaFile(env, r, pathParam(m[1]), pathParam(m[2])) },
  { method: "POST", re: /^\/calls\/([^/]+)\/transfer$/, h: (r, env, ec, m) => transfer(env, ec, r, pathParam(m[1])) },
  { method: "POST", re: /^\/calls\/([^/]+)\/warm-transfer$/, h: (r, env, ec, m) => warmTransfer(env, ec, r, pathParam(m[1])) },
  { method: "POST", re: /^\/calls\/([^/]+)\/hold$/, h: (r, env, ec, m) => hold(env, ec, r, pathParam(m[1])) },
  { method: "POST", re: /^\/calls\/([^/]+)\/resume$/, h: (r, env, ec, m) => resume(env, ec, r, pathParam(m[1])) },
  { method: "POST", re: /^\/calls\/([^/]+)\/events$/, h: (r, env, _ec, m) => events(env, r, pathParam(m[1])) },
  { method: "POST", re: /^\/sms\/send$/, h: (r, env, ec) => sendSms(env, ec, r) },
  { method: "GET", re: /^\/threads$/, h: (r, env) => listThreads(env, r) },
  { method: "GET", re: /^\/threads\/([^/]+)$/, h: (r, env, _ec, m) => getThread(env, r, m[1]) },
  { method: "GET", re: /^\/calls$/, h: (r, env) => listCalls(env, r) },
  { method: "GET", re: /^\/search$/, h: (r, env) => search(env, r) },
  { method: "GET", re: /^\/team$/, h: (r, env) => team(env, r) },
  { method: "POST", re: /^\/settings\/me$/, h: (r, env) => settingsMe(env, r) },
  { method: "POST", re: /^\/devices$/, h: (r, env) => devices(env, r) },
  { method: "POST", re: /^\/devices\/forget$/, h: (r, env) => forgetDevice(env, r) },
  { method: "POST", re: /^\/devices\/signout-all$/, h: (r, env) => signOutAll(env, r) },
  { method: "POST", re: /^\/log$/, h: (r, env) => log(env, r) },
  { method: "GET", re: /^\/turn$/, h: (r, env, ec) => turn(env, ec, r) },
  { method: "GET", re: /^\/quick-sends$/, h: (r, env, ec) => listQuickSends(env, ec, r) },
  { method: "POST", re: /^\/quick-sends$/, h: (r, env) => createQuickSend(env, r) },
  // The two actions before the plain /:id, so the id route can never take them.
  { method: "POST", re: /^\/quick-sends\/([^/]+)\/delete$/, h: (r, env, _ec, m) => deleteQuickSend(env, r, pathParam(m[1])) },
  { method: "POST", re: /^\/quick-sends\/([^/]+)\/used$/, h: (r, env, _ec, m) => quickSendUsed(env, r, pathParam(m[1])) },
  { method: "POST", re: /^\/quick-sends\/([^/]+)$/, h: (r, env, _ec, m) => updateQuickSend(env, r, pathParam(m[1])) },
  { method: "POST", re: /^\/push\/text$/, h: (r, env, ec) => pushText(env, ec, r) },
];

async function handleApp(req: Request, env: Env, ec: Ctx, path: string): Promise<Response> {
  const allowed = allowedOrigin(env, req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(allowed) });

  let pathMatched = false;
  for (const r of ROUTES) {
    const m = r.re.exec(path);
    if (!m) continue;
    pathMatched = true;
    if (r.method !== req.method) continue;
    try {
      return withCors(await r.h(req, env, ec, m), allowed);
    } catch (e) {
      if (e instanceof ApiError) return withCors(errorResponse(e), allowed);
      ec.waitUntil(logFault({
        code: e instanceof DbError ? `db_${e.op.replace(/\W+/g, "_").slice(0, 60)}` : "unhandled",
        message: (e as Error)?.message ?? String(e),
        req,
        context: { stack: String((e as Error)?.stack ?? "").slice(0, 2000) },
      }));
      return withCors(errorResponse(new ApiError("internal")), allowed);
    }
  }
  return withCors(
    pathMatched
      ? errorResponse(new ApiError("bad_request", "That method isn't allowed here.", 405))
      : errorResponse(new ApiError("not_found", "There's nothing here.")),
    allowed,
  );
}

// ── Entry points ────────────────────────────────────────────────────────────────────

/** Hits /health?warm=1 through the public URL, so placement runs it on the isolate that serves Twilio. */
async function keepWarm(env: Env): Promise<void> {
  const base = (env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  if (!base) return;
  const res = await fetch(`${base}/health?warm=1`, { headers: { "user-agent": "phone-api-keepwarm" } });
  await res.arrayBuffer();
}

export default {
  async fetch(req: Request, env: Env, ec: ExecutionContext): Promise<Response> {
    const t0 = Date.now();
    installDenoShim(env);
    const path = new URL(req.url).pathname.replace(/\/+$/, "") || "/";
    if (VOICE_PATHS.has(path)) {
      try {
        return await handleTwilio(req, env, ec, path, t0);
      } catch (e) {
        ec.waitUntil(logFault({
          code: "voice_unhandled", message: (e as Error)?.message ?? String(e), req,
          context: { path, stack: String((e as Error)?.stack ?? "").slice(0, 2000) },
        }));
        // No TwiML on purpose: a 500 sends Twilio to the Voice Fallback URL (voicemail).
        return new Response("Internal error", { status: 500 });
      }
    }
    if (path === "/") return json({ ok: true, service: "phone-api" });
    return handleApp(req, env, ec, path);
  },

  async scheduled(event: ScheduledController, env: Env, ec: ExecutionContext): Promise<void> {
    installDenoShim(env);
    // Each job on its own: a retention failure must not skip the billing jobs, or the reverse.
    const job = async (name: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (e) {
        await logFault({ code: "cron_failed", message: (e as Error)?.message ?? String(e), context: { cron: event.cron, job: name } });
      }
    };
    const at = new Date(event.scheduledTime || Date.now());
    const tick = event.cron === CRON_TICK;
    const sweepDue = event.cron === CRON_SWEEP || (tick && at.getUTCMinutes() % 15 === 0);
    const dailyDue = event.cron === CRON_DAILY || (tick && at.getUTCHours() === 9 && at.getUTCMinutes() === 0);
    const run = async () => {
      if (tick) await job("keep_warm", () => keepWarm(env));
      if (sweepDue) {
        await job("sweep", () => recordingSweep(env));
      }
      if (dailyDue) {
        await job("retention", () => retention(env));
        await job("usage_debit", () => debitDailyUsage(env, adminClient(env)));
        await job("line_fee", () => chargeMonthlyLineFees(env, adminClient(env)));
      }
    };
    ec.waitUntil(run());
  },
};
