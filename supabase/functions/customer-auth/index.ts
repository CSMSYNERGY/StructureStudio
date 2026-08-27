import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { logEdgeError, withErrorLog } from "../_shared/logError.ts";
import {
  toE164US,
  TwilioApiError,
  TwilioNotConfigured,
  twCheckVerification,
  twStartVerification,
} from "../_shared/twilioVerify.ts";
import { mintSession, revokeSession } from "../_shared/customerSession.ts";
import { clientIp } from "../_shared/adminGate.ts";

// customer-auth: phone-OTP sign-in for the customer quote portal — the "proper phone
// verification" 048's rollback note required before any design may be listed by phone.
// A shopper proves CONTROL of the number (Twilio Verify texts a code, they type it back)
// and receives an opaque bearer session (customer_sessions, hash-at-rest via
// _shared/customerSession.ts). Codes are generated, delivered and checked entirely by
// Twilio Verify — never stored or logged here, not even hashed (migration 108's split).
//
// Public in practice: the anon key passes the gateway, so verify_jwt is NOT auth. The
// real protections are the OTP itself, the per-phone + per-IP throttle buckets below,
// the tenant existence check, and US-only number validation.
//
// NO ENUMERATION: request_code behaves identically whether or not the phone has any
// quotes — we always send the code and always answer {ok:true}. Answering "no quotes
// for that number" BEFORE verification would let anyone holding the anon key probe
// which phones are customers of which builder — the exact class of leak 047/048 closed.
// Whether the portal turns out empty is learned only after the caller proves the phone.
//
// PII rule: phone digits never land in app_errors — not in messages, not in context
// (the same posture as twilioVerify.ts dropping Twilio's echo-the-number bodies). The
// throttle bucket name embeds the digits, so bucket names never go to logs either.

// ── Throttle (customer_otp_throttle, migration 108) ──────────────────────────────────
// Three buckets per send: '<clientId>:<digits>' (the target phone, per tenant),
// 'ip:<caller>' (adminGate's clientIp — the leftmost x-forwarded-for hop), and
// 'sends:tenant:<clientId>' (every send for the tenant — the forge-proof backstop).
//
// Why three (audit 2026-08-20): the per-IP bucket is honest attribution and a brake on
// naive scripts, but a client can PREPEND forged x-forwarded-for values and land every
// request in a fresh 'ip:<random>' bucket — and parsing a different XFF position is no
// fix, because on this platform the RIGHTMOST hop is Supabase's own rotating inbound
// proxy (adminGate.ts, verified empirically 2026-07-26), which would ALSO give every
// request a fresh bucket. The cap a rotating XFF cannot evade is the tenant-wide send
// cap: its key is built from the validated clientId, so no request header reaches it.
// It bounds the Twilio SMS spend an XFF-rotating pumper can bill to one tenant. It is a
// CAP, never a lock (053's rationale: one attacker must not be able to lock every
// legitimate shopper out of every tenant's portal): when it trips, sends are refused
// only until the 15-minute window rolls over — no locked_until is written for it.
//
// Send and fail counters share ONE rolling window: a bucket whose window_started_at is
// older than the window reads as zeroed and resets on its next write.
const THROTTLE_WINDOW_MS = 15 * 60_000; // counters and the lockout both use 15 minutes
const LOCKOUT_MS = 15 * 60_000;
const MAX_SENDS_PER_PHONE = 3; // codes texted to one phone per window (per tenant)
const MAX_SENDS_PER_IP = 10; // sends one caller may trigger per window, across phones
const MAX_SENDS_PER_TENANT = 30; // ALL sends for one tenant per window — the XFF-proof backstop
const MAX_FAILS_PER_PHONE = 5; // wrong codes before checks for that phone are refused

const MSG_TOO_MANY_CODES = "Too many codes requested. Try again in about 15 minutes.";
const MSG_NOT_CONFIGURED = "Sign-in by text isn't available yet.";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

type BucketState = {
  bucket: string;
  /** Effective counts: a bucket whose window has expired reads as zero. */
  sendCount: number;
  failCount: number;
  /** Parsed lock for the in-the-future test; the raw ISO is written back unchanged. */
  lockedUntilMs: number | null;
  lockedUntilIso: string | null;
  windowExpired: boolean;
  windowStartIso: string | null;
};

/** Read one throttle bucket. Returns null ONLY when the read itself failed —
 *  capture-lead's rule: a failed throttle read/write is a free pass, not an outage.
 *  Failing closed here would let one bad query lock every legitimate shopper out of
 *  every tenant's portal, which is strictly worse than briefly losing the cap. A
 *  missing row is NOT a failure — it reads as a zeroed bucket. */
async function readBucket(sb: any, bucket: string): Promise<BucketState | null> {
  const { data, error } = await sb.from("customer_otp_throttle")
    .select("send_count, fail_count, window_started_at, locked_until")
    .eq("bucket", bucket).maybeSingle();
  if (error) {
    // No bucket name in the warn — phone buckets embed the digits.
    console.warn(`customer-auth: throttle read failed: ${error.message}`);
    return null;
  }
  if (!data) {
    return {
      bucket, sendCount: 0, failCount: 0, lockedUntilMs: null, lockedUntilIso: null,
      windowExpired: false, windowStartIso: null,
    };
  }
  const started = Date.parse(String(data.window_started_at ?? ""));
  const windowExpired = !Number.isFinite(started) || Date.now() - started > THROTTLE_WINDOW_MS;
  const lockedMs = data.locked_until ? Date.parse(String(data.locked_until)) : NaN;
  return {
    bucket,
    sendCount: windowExpired ? 0 : Number(data.send_count) || 0,
    failCount: windowExpired ? 0 : Number(data.fail_count) || 0,
    lockedUntilMs: Number.isFinite(lockedMs) ? lockedMs : null,
    lockedUntilIso: data.locked_until ?? null,
    windowExpired,
    windowStartIso: data.window_started_at ?? null,
  };
}

/** Upsert one bucket. Counts default to the EFFECTIVE values in `s`, so saving a bucket
 *  whose window expired naturally resets it: the window restarts now and whichever
 *  counter isn't named drops to zero. Best-effort — the same free-pass rule as the
 *  read: a dropped write costs one uncounted send/fail, never the request. */
async function saveBucket(
  sb: any,
  s: BucketState,
  next: { send?: number; fail?: number; lockMs?: number },
): Promise<void> {
  const nowIso = new Date().toISOString();
  const { error } = await sb.from("customer_otp_throttle").upsert({
    bucket: s.bucket,
    send_count: next.send ?? s.sendCount,
    fail_count: next.fail ?? s.failCount,
    window_started_at: s.windowExpired || !s.windowStartIso ? nowIso : s.windowStartIso,
    locked_until: next.lockMs != null
      ? new Date(Date.now() + next.lockMs).toISOString()
      : s.lockedUntilIso,
    updated_at: nowIso,
  });
  if (error) console.warn(`customer-auth: throttle write failed: ${error.message}`);
}

Deno.serve(withErrorLog("customer-auth", async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  const action = typeof body?.action === "string" ? body.action : "";
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // ── logout {token} ──────────────────────────────────────────────────────────────────
  // Always {ok:true}: revokeSession never throws, and a revoke the database dropped
  // still dies at the session's TTL. A logout endpoint that 500s teaches customers
  // that logging out is broken.
  if (action === "logout") {
    await revokeSession(sb, body?.token);
    return json({ ok: true });
  }

  if (action !== "request_code" && action !== "verify_code") {
    return json({ error: "Unknown action" }, 400);
  }

  // ── Shared validation for the two OTP actions ────────────────────────────────────────
  // Tenant: slug shape + existence in client_configs (the same guard the public RPCs
  // and capture-lead use). One message for both failures — a probe can't tell "bad
  // shape" from "no such tenant".
  const clientId = typeof body?.clientId === "string" ? body.clientId.trim() : "";
  if (!/^[a-z0-9][a-z0-9-]*$/.test(clientId)) return json({ error: "Unknown builder link." }, 404);
  const { data: cfg } = await sb.from("client_configs")
    .select("client_id").eq("client_id", clientId).maybeSingle();
  if (!cfg) return json({ error: "Unknown builder link." }, 404);

  const phoneRaw = typeof body?.phone === "string" ? body.phone.trim().slice(0, 40) : "";
  const e164 = toE164US(phoneRaw.replace(/\D/g, ""));
  if (!e164) return json({ error: "Enter a valid US phone number." }, 400);
  // Canonical identity = the 10 digits after "+1", so "1 (555) 123-4567" and
  // "555-123-4567" are the SAME phone for throttling, for the session row, and for the
  // portal's designs lookup (whose index normalizes stored phones to digits).
  const digits = e164.slice(2);

  const name = typeof body?.name === "string" ? (body.name.trim().slice(0, 80) || null) : null;
  const phoneBucketKey = `${clientId}:${digits}`;

  // ── request_code {clientId, phone, name?} ────────────────────────────────────────────
  if (action === "request_code") {
    // Caller bucket key: adminGate's clientIp — the leftmost x-forwarded-for hop, the only
    // entry that even resembles the caller on this platform (the rightmost is Supabase's
    // rotating inbound proxy; see adminGate.ts). A client can forge it, so this bucket is
    // attribution + a brake on naive scripts — the forge-proof cap is the tenant bucket
    // below (audit 2026-08-20). Requests carrying no header pool under "unknown".
    const ip = clientIp(req);
    const phoneBucket = await readBucket(sb, phoneBucketKey);
    const ipBucket = await readBucket(sb, `ip:${ip}`);
    // 'sends:tenant:<slug>' cannot collide with a phone bucket — even for a tenant whose
    // slug is literally "sends", a phone key ends in ':<10 digits>' and this one never
    // does — nor with an 'ip:' bucket.
    const tenantBucket = await readBucket(sb, `sends:tenant:${clientId}`);

    // An unexpired lockout short-circuits before any count math. (The tenant bucket never
    // carries a lock — cap-only, see the header.)
    const now = Date.now();
    if ((phoneBucket?.lockedUntilMs ?? 0) > now || (ipBucket?.lockedUntilMs ?? 0) > now) {
      return json({ error: MSG_TOO_MANY_CODES }, 429);
    }

    // Caps: 3 sends to one phone (per tenant) or 10 sends from one caller inside a
    // window locks the breaching bucket(s) for 15 minutes. 30 sends tenant-wide refuses
    // WITHOUT a lock — the un-forgeable backstop (audit 2026-08-20): a caller rotating
    // x-forwarded-for gets a fresh ip bucket every request, but every send still lands in
    // this one tenant bucket, so the tenant's Twilio bill is bounded at 30 texts per
    // 15 minutes however many IPs the attacker claims to be. Legitimate shoppers caught
    // behind a tripped tenant cap are back the moment the window rolls over.
    const phoneOver = phoneBucket !== null && phoneBucket.sendCount >= MAX_SENDS_PER_PHONE;
    const ipOver = ipBucket !== null && ipBucket.sendCount >= MAX_SENDS_PER_IP;
    const tenantOver = tenantBucket !== null && tenantBucket.sendCount >= MAX_SENDS_PER_TENANT;
    if (phoneOver || ipOver || tenantOver) {
      if (phoneOver && phoneBucket) await saveBucket(sb, phoneBucket, { lockMs: LOCKOUT_MS });
      if (ipOver && ipBucket) await saveBucket(sb, ipBucket, { lockMs: LOCKOUT_MS });
      return json({ error: MSG_TOO_MANY_CODES }, 429);
    }

    // The tenant's own name brands the code text (see twSanitizeBrand). Read here rather
    // than at the tenant check above so a `verify_code` call never pays for it — only the
    // send needs it. Best-effort by construction: `client_settings` is service-role-only and
    // this function holds that role, but a missing row or a blank name simply omits the
    // override and Twilio falls back to the service default. A customer must never fail to
    // log in because their builder left a settings field empty.
    // Falls back to the config row's company_name — the same pair customer-quotes and the
    // portal shell read — so a tenant with no client_settings row still gets their own name
    // in the code text instead of ours, matching the header their customer is looking at.
    let brand = "";
    {
      const [bsRes, cfgRes] = await Promise.all([
        sb.from("client_settings").select("business_name").eq("client_id", clientId).maybeSingle(),
        sb.from("client_configs").select("company_name").eq("client_id", clientId).maybeSingle(),
      ]);
      const name = bsRes.data?.business_name || cfgRes.data?.company_name;
      brand = typeof name === "string" ? name : "";
    }

    try {
      await twStartVerification(e164, brand);
    } catch (e) {
      if (e instanceof TwilioNotConfigured) {
        return json({ error: MSG_NOT_CONFIGURED }, 503);
      }
      if (e instanceof TwilioApiError) {
        if (e.code === 60203) {
          // Twilio's own max-send lock — the verification is frozen until its TTL, so
          // surface the same "wait it out" message as our lockout.
          return json({ error: MSG_TOO_MANY_CODES }, 429);
        }
        if (e.permanent) {
          // Malformed/unreachable/landline — an identical retry fails identically.
          return json({ error: "We couldn't text that number." }, 400);
        }
        // Transient (Twilio 429/5xx/network). withErrorLog also records the 502 below,
        // but only this row carries the Twilio verdict. e.message is safe by the
        // transport's contract (endpoint + status + code, never the phone).
        await logEdgeError({
          fn: "customer-auth", req, clientId, code: "twilio_send",
          message: `Twilio Verify send failed transiently: ${e.message}`,
          context: { twilioStatus: e.status, twilioCode: e.code },
        });
        return json({ error: "Something went wrong sending the code — try again." }, 502);
      }
      throw e; // not a Twilio shape — let withErrorLog record it as unhandled
    }

    // Sent. Count it in all THREE buckets (best-effort — the free-pass rule again).
    if (phoneBucket) await saveBucket(sb, phoneBucket, { send: phoneBucket.sendCount + 1 });
    if (ipBucket) await saveBucket(sb, ipBucket, { send: ipBucket.sendCount + 1 });
    if (tenantBucket) await saveBucket(sb, tenantBucket, { send: tenantBucket.sendCount + 1 });

    // Housekeeping (adminGate.ts's pattern, audit 2026-08-20): an XFF-rotating caller
    // writes one junk 'ip:<forged>' row per request that is never read again — without a
    // sweep the table grows forever. Runs only when THIS request minted a brand-new ip
    // bucket (windowStartIso null = no prior row), so steady legitimate traffic never
    // pays for it, and it is best-effort like every other throttle write. Rows that ever
    // held a lock are left alone (locked_until stays set after expiry); they are few.
    if (ipBucket && ipBucket.windowStartIso === null) {
      try {
        const stale = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        await sb.from("customer_otp_throttle").delete().lt("updated_at", stale).is("locked_until", null);
      } catch (e) {
        console.warn(`customer-auth: throttle housekeeping failed: ${(e as Error).message}`);
      }
    }

    // {ok:true} whether or not this phone has any quotes — see NO ENUMERATION in the
    // header. `name` deliberately goes nowhere on this action: the client carries it
    // through to verify_code, where it lands on the minted session.
    return json({ ok: true });
  }

  // ── verify_code {clientId, phone, code, name?} ───────────────────────────────────────
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!/^\d{4,8}$/.test(code)) {
    return json({ error: "Enter the code from the text we sent." }, 400);
  }

  const phoneBucket = await readBucket(sb, phoneBucketKey);
  // 5 wrong codes inside one window refuses further checks until the window rolls
  // over. Only fail_count gates here — a SEND lockout must not stop someone verifying
  // a code they already received.
  if (phoneBucket !== null && phoneBucket.failCount >= MAX_FAILS_PER_PHONE) {
    return json({ error: "Too many attempts. Try again in about 15 minutes." }, 429);
  }

  let check: { approved: boolean; status: string };
  try {
    check = await twCheckVerification(e164, code);
  } catch (e) {
    if (e instanceof TwilioNotConfigured) {
      return json({ error: MSG_NOT_CONFIGURED }, 503);
    }
    if (e instanceof TwilioApiError) {
      if (e.code === 60202) {
        // Twilio's own max-check lock on this verification — a new code is the only out.
        return json({ error: "Too many attempts — request a new code." }, 429);
      }
      // Anything else here is effectively transient: 20404 (expired) is mapped to a
      // value by the transport, and the To number was built by us from a validated
      // phone. Same logging note as the send path — no digits in the row.
      await logEdgeError({
        fn: "customer-auth", req, clientId, code: "twilio_check",
        message: `Twilio Verify check failed: ${e.message}`,
        context: { twilioStatus: e.status, twilioCode: e.code, permanent: e.permanent },
      });
      return json({ error: "Something went wrong checking the code — try again." }, 502);
    }
    throw e; // not a Twilio shape — let withErrorLog record it as unhandled
  }

  if (!check.approved) {
    // Wrong or expired code — count the failure toward the lockout above (best-effort).
    if (phoneBucket) await saveBucket(sb, phoneBucket, { fail: phoneBucket.failCount + 1 });
    return json({
      error: check.status === "expired"
        ? "That code expired — request a new one."
        : "That code didn't match — check and try again.",
    }, 401);
  }

  // Approved: the caller has PROVEN control of the phone. Clear the fail counter and
  // mint the opaque bearer session — customer_sessions stores only its hash, and
  // mintSession throws on a failed write (a token with no row behind it would fail
  // every later check silently), which withErrorLog turns into a logged 500.
  if (phoneBucket) await saveBucket(sb, phoneBucket, { fail: 0 });
  const token = await mintSession(sb, clientId, digits, name);
  return json({ ok: true, token, name });
}));
