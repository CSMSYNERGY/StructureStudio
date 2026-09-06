import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { logEdgeError, withErrorLog, SS_REFUSAL_HEADER } from "../_shared/logError.ts";
import {
  toE164US,
  TwilioApiError,
  TwilioNotConfigured,
  twCheckVerification,
  twilioConfigured,
  twStartVerification,
} from "../_shared/twilioVerify.ts";
import { mintSession, revokeSession } from "../_shared/customerSession.ts";
import { rsSendEmail, resendConfigured, ResendApiError } from "../_shared/resend.ts";
import {
  isPlausibleEmail, normalizeEmail, issueEmailOtp, verifyEmailOtp, emailOtpBody,
  EmailOtpNotConfigured,
} from "../_shared/emailOtp.ts";
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
//
// A send is COUNTED BY CLAIMING IT, not by writing back what was read — see reserveSendSlot.
// Reading a count, checking it and later storing read+1 is not a cap at all under concurrent
// requests, and the tenant-wide backstop above is worth only as much as its counter.
const THROTTLE_WINDOW_MS = 15 * 60_000; // counters and the lockout both use 15 minutes
const LOCKOUT_MS = 15 * 60_000;
const MAX_SENDS_PER_PHONE = 3; // codes texted to one phone per window (per tenant)
const MAX_SENDS_PER_IP = 10; // sends one caller may trigger per window, across phones
const MAX_SENDS_PER_TENANT = 30; // ALL sends for one tenant per window — the XFF-proof backstop
const MAX_FAILS_PER_PHONE = 5; // wrong codes before checks for that phone are refused

// ── The EMAIL channel (2026-08-30) ────────────────────────────────────────────────────
// A second way in, because this function was SMS-ONLY and customer login therefore died on
// ANY Twilio unavailability — an outage, a billing lapse, a mistyped token, or a messaging
// suspension on the shared ISV account. The code is delivered by Resend FROM THE BUILDER'S
// OWN DOMAIN, so it arrives from the same sender that sent the quote.
//
// ⚠️ THE SESSION IS STILL KEYED ON THE PHONE. customer_sessions.phone_digits is NOT NULL and
// the whole quote lookup is phone-based, so a verified email is RESOLVED to a phone through
// the tenant's designs. That resolution is the weak joint of this channel and is guarded
// accordingly — designs.contact is written by whoever submitted the design, the anonymous
// designer included, so it is a claim about a number and never proof of one. See the rules
// at the resolution itself: only a design the customer would recognise as a quote may supply
// an identity, and a number another address already answers to supplies none. If nothing
// resolves, no identity is minted and the honest answer is that we have no quotes for that
// address. That answer is only ever given AFTER the code is proven, which is what keeps the
// NO ENUMERATION rule intact: the send path behaves identically for every address.
//
// ⚠️ Unlike the SMS path, WE hold this code — Twilio Verify holds its own. See
// _shared/emailOtp.ts for why it is stored as a keyed hash and never a bare digest.
const MSG_TOO_MANY_CODES = "Too many codes requested. Try again in about 15 minutes.";
const MSG_NOT_CONFIGURED = "Sign-in by text isn't available yet.";
// Mirrors PLATFORM_FROM in emailSend.ts, on the domain whose Resend records are published
// (send.mail… MX + SPF, resend._domainkey.mail… DKIM; DMARC inherits the apex's p=none).
// Deliberately a separate constant rather than an import: emailSend.ts does not export it,
// and this path must not acquire a dependency on the tenant mail module it exists to avoid.
const PLATFORM_LOGIN_FROM = "StructureStudio <no-reply@mail.structurestudiosuite.com>";
const MSG_EMAIL_NOT_CONFIGURED = "Sign-in by email isn't available yet.";
// Said for a wrong code, an expired one, a consumed one and a never-issued one alike. The
// distinctions are real but telling them apart is a probing oracle, and none of them change
// what the customer should do next: ask for another code.
const MSG_EMAIL_CODE_BAD = "That code didn't match or has expired — request a new one.";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

// Sign-in by text is simply not switched on for this tenant — no Twilio credentials, no
// Verify service. There is no 4xx that says "the operator has not enabled this", so it
// answers 503, which would otherwise file as a fault every time a customer taps the
// button. It is the product declining, so it says so and lands as info instead.
const refusal = (b: unknown, s = 503) => {
  const r = json(b, s);
  // EXPOSED, or the browser cannot read it. A custom response header is invisible to
  // cross-origin JS unless it is named in Access-Control-Expose-Headers, and the portal
  // calls this function cross-origin. Without this line the mark is set, travels, and is
  // silently unreadable in the browser - so a deliberate 5xx refusal ("Taking cards is not
  // switched on for this account yet") kept filing as a FAULT in app_errors.
  r.headers.set(SS_REFUSAL_HEADER, "1");
  r.headers.set("Access-Control-Expose-Headers", SS_REFUSAL_HEADER);
  return r;
};

type BucketState = {
  bucket: string;
  /** Effective counts: a bucket whose window has expired reads as zero. */
  sendCount: number;
  failCount: number;
  /** The send_count actually STORED on the row — not zeroed for an expired window. It is
   *  the compare-and-swap token reserveSendSlot matches on, so it has to be the literal
   *  value in the row rather than the effective one. 0 when there is no row yet. */
  rawSendCount: number;
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
      bucket, sendCount: 0, failCount: 0, rawSendCount: 0, lockedUntilMs: null,
      lockedUntilIso: null, windowExpired: false, windowStartIso: null,
    };
  }
  const started = Date.parse(String(data.window_started_at ?? ""));
  const windowExpired = !Number.isFinite(started) || Date.now() - started > THROTTLE_WINDOW_MS;
  const lockedMs = data.locked_until ? Date.parse(String(data.locked_until)) : NaN;
  return {
    bucket,
    sendCount: windowExpired ? 0 : Number(data.send_count) || 0,
    rawSendCount: Number(data.send_count) || 0,
    failCount: windowExpired ? 0 : Number(data.fail_count) || 0,
    lockedUntilMs: Number.isFinite(lockedMs) ? lockedMs : null,
    lockedUntilIso: data.locked_until ?? null,
    windowExpired,
    windowStartIso: data.window_started_at ?? null,
  };
}

/** Upsert one bucket's FAIL counter or lockout. Counts default to the EFFECTIVE values in
 *  `s`, so saving a bucket whose window expired naturally resets it: the window restarts
 *  now and whichever counter isn't named drops to zero. Best-effort — the same free-pass
 *  rule as the read: a dropped write costs one uncounted fail, never the request.
 *
 *  ⚠️ SENDS ARE NOT COUNTED HERE. There is deliberately no `send` option: writing back a
 *  count read earlier is what let concurrent requests share one slot, and reserveSendSlot
 *  below owns that counter now. Two ways to write send_count is how one of them drifts. */
async function saveBucket(
  sb: any,
  s: BucketState,
  next: { fail?: number; lockMs?: number },
): Promise<void> {
  const nowIso = new Date().toISOString();
  const { error } = await sb.from("customer_otp_throttle").upsert({
    bucket: s.bucket,
    send_count: s.sendCount,
    fail_count: next.fail ?? s.failCount,
    window_started_at: s.windowExpired || !s.windowStartIso ? nowIso : s.windowStartIso,
    locked_until: next.lockMs != null
      ? new Date(Date.now() + next.lockMs).toISOString()
      : s.lockedUntilIso,
    updated_at: nowIso,
  });
  if (error) console.warn(`customer-auth: throttle write failed: ${error.message}`);
}

/** What a slot claim decided. 'unknown' is the free pass — see reserveSendSlot. */
type SlotVerdict = "ok" | "over" | "unknown";

/** Swaps one claim will try before giving the request a free pass. Each round costs a
 *  primary-key read plus one conditional update, and a round is only ever spent when
 *  another request claimed the same bucket in between — so this is the width of a
 *  simultaneous burst the counter stays exact through, traded against the latency the
 *  unluckiest caller in that burst pays. */
const CLAIM_ATTEMPTS = 12;

/**
 * Claim ONE send slot in `bucket`, enforcing `max`.
 *
 * ⚠️ WHY THIS EXISTS AND saveBucket DOES NOT SUFFICE. Reading a counter, checking it against
 * a cap and later writing `read + 1` is not a limit at all once two requests overlap: both
 * read the same low value, both pass the check, both send, and both write the SAME number.
 * The counter never climbs, so neither the caps nor the lockout that depends on them ever
 * bite — the send budget is effectively unbounded to anyone willing to pipeline. That is
 * worst for the tenant-wide bucket, which the header calls the one cap a caller rotating
 * x-forwarded-for cannot escape, and which is what bounds a tenant's messaging spend.
 *
 * The claim is therefore a COMPARE-AND-SWAP: the update matches only while the row still
 * holds the count this request read, so exactly one of N simultaneous claims lands on each
 * value and the losers re-read a higher one. `customer_otp_throttle` has no atomic increment
 * (migration 108 is deliberately "just the counters"), so the primary key and the matched
 * count are the whole serialisation.
 *
 * Rules kept from the read/write pair it replaces:
 *   * FREE PASS ON FAILURE. A read or write that ERRORS returns 'unknown' and the caller
 *     sends anyway — capture-lead's rule. Failing closed would let one bad query lock every
 *     legitimate shopper out of every tenant's portal, which is worse than losing the cap.
 *     Contention we cannot resolve inside the retry budget is treated the same way, and
 *     that is the honest limit of this fix: a burst wider than CLAIM_ATTEMPTS arriving in
 *     the same instant still overshoots once, because only one swap can land per round and
 *     the rest are let through rather than refused. What it buys is that the count now
 *     genuinely CLIMBS, so the overshoot is a single bounded spike instead of an unbounded
 *     one — after it the bucket is at its cap and stays there for the rest of the window,
 *     which is what a 15-minute pumping run actually runs into.
 *   * WINDOW ROLLOVER STILL ZEROES. A bucket whose window lapsed restarts at one send and
 *     no fails, exactly as saveBucket's expired branch does.
 *   * NEVER A LOCK. `locked_until` is not named in either statement, so a claim can neither
 *     set nor clear one — the tenant bucket stays cap-only (053's rationale, migration 108).
 *   * The bucket name never reaches a log line: phone buckets embed the digits and email
 *     buckets the address.
 *
 * `seed` is the state the caller already read for its cheap pre-check, reused as the first
 * attempt so the happy path costs no extra read.
 */
async function reserveSendSlot(
  // deno-lint-ignore no-explicit-any
  sb: any,
  bucket: string,
  max: number,
  seed: BucketState | null,
): Promise<SlotVerdict> {
  let s = seed;
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
    // A seed of null is "the caller's read failed", not "no seed" — read again rather than
    // inheriting that failure, so one flaky read costs a cap check and not the counter too.
    if (attempt > 0 || s === null) s = await readBucket(sb, bucket);
    if (s === null) return "unknown"; // the read itself failed — free pass
    if (s.sendCount >= max) return "over";
    const nowIso = new Date().toISOString();
    if (s.windowStartIso === null) {
      // No row yet: the INSERT is the claim, and a racing insert loses on the primary key.
      const { error } = await sb.from("customer_otp_throttle").insert({
        bucket, send_count: 1, fail_count: 0, window_started_at: nowIso, updated_at: nowIso,
      });
      if (!error) return "ok";
      // 23505 = another request inserted this bucket first, which IS the serialisation
      // working — re-read and swap instead. Anything else is a broken write: free pass,
      // and no retry storm against a table that is not answering.
      if (error.code !== "23505") {
        console.warn(`customer-auth: throttle claim insert failed: ${error.message}`);
        return "unknown";
      }
      continue;
    }
    const patch = s.windowExpired
      ? { send_count: 1, fail_count: 0, window_started_at: nowIso, updated_at: nowIso }
      : { send_count: s.rawSendCount + 1, updated_at: nowIso };
    const { data, error } = await sb.from("customer_otp_throttle")
      .update(patch).eq("bucket", bucket).eq("send_count", s.rawSendCount).select("bucket");
    if (error) {
      console.warn(`customer-auth: throttle claim failed: ${error.message}`);
      return "unknown";
    }
    if (Array.isArray(data) && data.length > 0) return "ok";
    // Lost the swap: another send landed in this window. Re-read and try again.
  }
  return "unknown";
}

/** Hand one claimed slot back, for the case where the provider refused OUTRIGHT and nothing
 *  was delivered. Best-effort and never fatal: a release that loses its compare-and-swap
 *  simply leaves the send counted, and over-counting is the safe direction for a cap. */
async function releaseSendSlot(
  // deno-lint-ignore no-explicit-any
  sb: any,
  bucket: string,
): Promise<void> {
  const s = await readBucket(sb, bucket);
  if (s === null || s.windowStartIso === null || s.rawSendCount <= 0) return;
  const { error } = await sb.from("customer_otp_throttle")
    .update({ send_count: s.rawSendCount - 1, updated_at: new Date().toISOString() })
    .eq("bucket", bucket).eq("send_count", s.rawSendCount);
  if (error) console.warn(`customer-auth: throttle release failed: ${error.message}`);
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

  // Which channel this request is for. Absent/anything-else means SMS, so every existing
  // caller keeps working untouched — the portal only sends `channel` when the customer picks
  // the email route.
  const channel = body?.channel === "email" ? "email" : "sms";

  // ── Shared validation for the two OTP actions ────────────────────────────────────────
  // Tenant: slug shape + existence in client_configs (the same guard the public RPCs
  // and capture-lead use). One message for both failures — a probe can't tell "bad
  // shape" from "no such tenant".
  const clientId = typeof body?.clientId === "string" ? body.clientId.trim() : "";
  if (!/^[a-z0-9][a-z0-9-]*$/.test(clientId)) return json({ error: "Unknown builder link." }, 404);
  const { data: cfg } = await sb.from("client_configs")
    .select("client_id").eq("client_id", clientId).maybeSingle();
  if (!cfg) return json({ error: "Unknown builder link." }, 404);

  // ── EMAIL CHANNEL: TURNED OFF 2026-09-06, and it must stay off until the identity model
  // below changes. ───────────────────────────────────────────────────────────────────────
  //
  // The channel proves an EMAIL ADDRESS and then mints the session on a PHONE it read off a
  // design's `contact` blob. That blob is written by `save_design`, which is granted to anon
  // and stores it verbatim — so the phone is a claim by whoever filed the design, never a
  // proven fact. Pair your own address with someone else's number, verify a code to your own
  // inbox, and the session you get is theirs: `customer-quotes` lists every design matching
  // that phone and `customer-accept` will sign their invoice on it.
  //
  // ⚠️ THE DEFENCES BELOW IN handleEmailChannel ARE REAL BUT NOT SUFFICIENT, so do not read
  // them as a reason to re-open this. Skipping draft/inventory rows stops nothing an attacker
  // does — `save_design` writes `coalesce(p_status,'sent')`, so OMITTING the status field
  // files the plant as 'sent'. The contradiction rule (a number whose designs disagree about
  // the address supplies no identity) is the one that bites, and it cannot fire for a tenant
  // that does not collect email at all: every contact is phone-only, nothing contradicts, and
  // the plant resolves.
  //
  // Cost of turning it off: none measured. Zero email codes had ever been issued on this
  // project when it was disabled (`select count(*) from customer_email_otps` = 0; all 15
  // customer sessions came through SMS), and the SMS channel — where the OTP proves the very
  // phone the session is keyed on — is unaffected.
  //
  // To re-open it, mint the session on the VERIFIED ADDRESS instead of back-resolving to a
  // phone: `customer_sessions.phone_digits` (NOT NULL, migration 108) needs to become
  // nullable beside an `email_lower`, and `customer-quotes` / `customer-accept` /
  // `customer-pay` need to match on the address when the session is email-keyed. Then delete
  // this block. Everything under handleEmailChannel is left intact for that work.
  if (channel === "email") {
    return refusal({
      error: "Signing in by email isn't available right now — use your mobile number and " +
             "we'll text you a code.",
    });
  }

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
    // Named once: the pre-check read and the claim below MUST address the same rows, and a
    // second copy of either template is how they would quietly stop doing so.
    const ipBucketKey = `ip:${ip}`;
    // 'sends:tenant:<slug>' cannot collide with a phone bucket — even for a tenant whose
    // slug is literally "sends", a phone key ends in ':<10 digits>' and this one never
    // does — nor with an 'ip:' bucket.
    const tenantBucketKey = `sends:tenant:${clientId}`;
    const phoneBucket = await readBucket(sb, phoneBucketKey);
    const ipBucket = await readBucket(sb, ipBucketKey);
    const tenantBucket = await readBucket(sb, tenantBucketKey);

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

    // ⚠️ THE DEPLOYMENT CHECK COMES BEFORE ANY SLOT IS CLAIMED. Sign-in by text being
    // switched off is a property of the deployment's Twilio credentials, not of this
    // request, so on a deployment without them EVERY caller would arrive here — and the
    // portal asks for the SMS channel by default. Claiming a slot first would let those
    // requests spend the tenant's send budget having sent nothing, and that budget is SHARED
    // with the email channel, which exists precisely for the days SMS cannot send. The same
    // refusal is repeated inside the catch below as belt-and-braces.
    if (!twilioConfigured()) {
      return refusal({ error: MSG_NOT_CONFIGURED });
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

    // ── Claim the three send slots, THEN send ──────────────────────────────────────────
    // The cap above is a read-then-check and cannot bind on its own (see reserveSendSlot).
    // The claim sits HERE, after every exit that sends nothing and immediately before the
    // provider call, because the atomicity the cap needs is only required around the send
    // itself — a claim taken earlier would charge the tenant's shared budget for requests
    // that never sent anything.
    const slots = await Promise.all([
      reserveSendSlot(sb, phoneBucketKey, MAX_SENDS_PER_PHONE, phoneBucket),
      reserveSendSlot(sb, ipBucketKey, MAX_SENDS_PER_IP, ipBucket),
      reserveSendSlot(sb, tenantBucketKey, MAX_SENDS_PER_TENANT, tenantBucket),
    ]);
    // No lockout is written here: the pre-check above owns that escalation and sees the
    // breached count on the next request. The tenant bucket is never locked at all.
    if (slots.some((v) => v === "over")) return json({ error: MSG_TOO_MANY_CODES }, 429);
    const claimed = [phoneBucketKey, ipBucketKey, tenantBucketKey]
      .filter((_b, i) => slots[i] === "ok");

    try {
      await twStartVerification(e164, brand);
    } catch (e) {
      if (e instanceof TwilioNotConfigured) {
        await Promise.all(claimed.map((b) => releaseSendSlot(sb, b)));
        return refusal({ error: MSG_NOT_CONFIGURED });
      }
      if (e instanceof TwilioApiError) {
        // A permanent refusal means the provider sent NOTHING — give the slots back rather
        // than letting cheap, guaranteed-to-fail requests exhaust a real tenant's budget.
        // A transient failure keeps them: a send may well have gone out, and over-counting
        // is the safe direction for a cap.
        if (e.permanent) await Promise.all(claimed.map((b) => releaseSendSlot(sb, b)));
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

    // Sent — and already counted in all three buckets by the claim above.

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
      return refusal({ error: MSG_NOT_CONFIGURED });
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

/**
 * The email sign-in channel.
 *
 * Mirrors the phone path's guarantees deliberately, one for one:
 *   * the SAME throttle buckets and caps — a caller must not get a fresh budget by switching
 *     channel, which would make the email route a way around the SMS limits
 *   * NO ENUMERATION on request_code — always {ok:true}, whether or not the address has quotes
 *   * the address never reaches app_errors, exactly as phone digits never do
 */
async function handleEmailChannel(
  // deno-lint-ignore no-explicit-any
  sb: any,
  req: Request,
  action: string,
  // deno-lint-ignore no-explicit-any
  body: any,
  clientId: string,
): Promise<Response> {
  const emailRaw = typeof body?.email === "string" ? body.email.slice(0, 254) : "";
  const email = normalizeEmail(emailRaw);
  if (!isPlausibleEmail(email)) return json({ error: "Enter a valid email address." }, 400);

  const name = typeof body?.name === "string" ? (body.name.trim().slice(0, 80) || null) : null;
  // ⚠️ The bucket key is namespaced 'email:' so it cannot collide with a phone bucket
  // ('<clientId>:<10 digits>') — but the IP and TENANT buckets are SHARED with the SMS path
  // on purpose. Separate ones would hand an attacker a second full budget for free.
  const emailBucketKey = `email:${clientId}:${email}`;

  if (action === "request_code") {
    const ip = clientIp(req);
    // Named once, as on the phone path: the pre-check and the claim must address the same rows.
    const ipBucketKey = `ip:${ip}`;
    const tenantBucketKey = `sends:tenant:${clientId}`;
    const emailBucket = await readBucket(sb, emailBucketKey);
    const ipBucket = await readBucket(sb, ipBucketKey);
    const tenantBucket = await readBucket(sb, tenantBucketKey);

    const now = Date.now();
    if ((emailBucket?.lockedUntilMs ?? 0) > now || (ipBucket?.lockedUntilMs ?? 0) > now) {
      return json({ error: MSG_TOO_MANY_CODES }, 429);
    }
    const emailOver = emailBucket !== null && emailBucket.sendCount >= MAX_SENDS_PER_PHONE;
    const ipOver = ipBucket !== null && ipBucket.sendCount >= MAX_SENDS_PER_IP;
    const tenantOver = tenantBucket !== null && tenantBucket.sendCount >= MAX_SENDS_PER_TENANT;
    if (emailOver || ipOver || tenantOver) {
      if (emailOver && emailBucket) await saveBucket(sb, emailBucket, { lockMs: LOCKOUT_MS });
      if (ipOver && ipBucket) await saveBucket(sb, ipBucket, { lockMs: LOCKOUT_MS });
      return json({ error: MSG_TOO_MANY_CODES }, 429);
    }

    let brand = "";
    {
      const [bsRes, cfgRes] = await Promise.all([
        sb.from("client_settings").select("business_name").eq("client_id", clientId).maybeSingle(),
        sb.from("client_configs").select("company_name").eq("client_id", clientId).maybeSingle(),
      ]);
      const n = bsRes.data?.business_name || cfgRes.data?.company_name;
      brand = typeof n === "string" ? n : "";
    }

    let issued;
    try {
      issued = await issueEmailOtp(clientId, email);
    } catch (e) {
      if (e instanceof EmailOtpNotConfigured) return refusal({ error: MSG_EMAIL_NOT_CONFIGURED });
      throw e;
    }

    // ⚠️ STORE BEFORE SENDING. A code in someone's inbox that this table never recorded can
    // never be verified, and the customer would be typing a valid-looking code at a wall.
    // The reverse order is recoverable: a stored code that failed to send is simply unused.
    // Upsert replaces any live code for this address — asking for a new one kills the old.
    const { error: upErr } = await sb.from("customer_email_otps").upsert({
      client_id: clientId,
      email_lower: email,
      code_hash: issued.codeHash,
      expires_at: issued.expiresAt.toISOString(),
      attempts: 0,
      consumed_at: null,
      created_at: new Date().toISOString(),
    }, { onConflict: "client_id,email_lower" });
    if (upErr) {
      await logEdgeError({
        fn: "customer-auth", req, clientId, code: "email_otp_store",
        message: `could not store the email sign-in code: ${upErr.message}`,
      });
      return json({ error: "Something went wrong sending the code — try again." }, 502);
    }

    // ── Sent by the PLATFORM, not by the tenant — and that is the whole point ──────────
    // This deliberately does NOT go through sendTenantEmail. That function gates on the
    // tenant's own `email_provider` and verified domain, which would make CUSTOMER LOGIN
    // depend on each builder configuring email — exactly the fragility this fallback exists
    // to remove. Today every tenant is still on 'ghl', so routing login codes through it made
    // the fallback inert for all six of them.
    //
    // A login code is an AUTHENTICATION function of the platform, not the builder's business
    // mail: it says "prove you own this address", carries nothing of the builder's, and needs
    // to work on the worst day rather than the best one. So it sends from the platform domain
    // on the platform's Resend key, gated on nothing per-tenant. The builder's name still
    // appears in the BODY, which is where a customer actually looks.
    //
    // ⚠️ Not ledgered in email_sends. That table is the tenant's business-mail record, keyed
    // to their sends; a platform auth code is not their correspondence, and writing the
    // recipient there would put an address in a tenant-visible ledger for a message they did
    // not send. (migration 167 still adds the 'login_code' kind — harmless, and it keeps the
    // constraint honest if this is ever revisited.)
    if (!resendConfigured() || Deno.env.get("PLATFORM_EMAIL_DOMAIN_READY") !== "true") {
      return refusal({ error: MSG_EMAIL_NOT_CONFIGURED });
    }
    // ── Claim the three send slots, THEN send ──────────────────────────────────────────
    // Same compare-and-swap claim as the phone path, in the same place and for the same
    // reason: last, after the not-configured refusals and the code store, immediately before
    // the provider call. Everything above this line can refuse having sent nothing, and the
    // IP and TENANT buckets are shared with the SMS path — spending them on a non-send would
    // take the budget away from the channel that IS working. A stored code that is then
    // refused a slot is simply unused; the next request replaces it.
    const slots = await Promise.all([
      reserveSendSlot(sb, emailBucketKey, MAX_SENDS_PER_PHONE, emailBucket),
      reserveSendSlot(sb, ipBucketKey, MAX_SENDS_PER_IP, ipBucket),
      reserveSendSlot(sb, tenantBucketKey, MAX_SENDS_PER_TENANT, tenantBucket),
    ]);
    if (slots.some((v) => v === "over")) return json({ error: MSG_TOO_MANY_CODES }, 429);

    const mail = emailOtpBody(brand, issued.code);
    try {
      await rsSendEmail({
        from: PLATFORM_LOGIN_FROM,
        to: email,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        tags: [{ name: "kind", value: "login_code" }, { name: "client_id", value: clientId }],
      });
    } catch (e) {
      // ⚠️ Resend's message can echo the recipient (its testing-mode 403 names the address you
      // may send to), so only the enum-ish status/name travels — the same rule emailSend's
      // errText follows.
      const detail = e instanceof ResendApiError ? `resend ${e.status}/${e.name_ || "unknown"}` : "send failed";
      await logEdgeError({
        fn: "customer-auth", req, clientId, code: "email_otp_send",
        message: `email sign-in code failed to send: ${detail}`,
      });
      return json({ error: "Something went wrong sending the code — try again." }, 502);
    }

    // Sent — and already counted in all three buckets by the claim above.

    // {ok:true} regardless — see NO ENUMERATION in the header.
    return json({ ok: true });
  }

  // ── verify_code ────────────────────────────────────────────────────────────────────
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!/^\d{4,8}$/.test(code)) {
    return json({ error: "Enter the code from the email we sent." }, 400);
  }

  const emailBucket = await readBucket(sb, emailBucketKey);
  if (emailBucket !== null && emailBucket.failCount >= MAX_FAILS_PER_PHONE) {
    return json({ error: "Too many attempts. Try again in about 15 minutes." }, 429);
  }

  const { data: row } = await sb.from("customer_email_otps")
    .select("code_hash, expires_at, attempts, consumed_at")
    .eq("client_id", clientId).eq("email_lower", email).maybeSingle();

  let verdict;
  try {
    verdict = await verifyEmailOtp(clientId, email, code, row ?? null);
  } catch (e) {
    if (e instanceof EmailOtpNotConfigured) return refusal({ error: MSG_EMAIL_NOT_CONFIGURED });
    throw e;
  }

  if (!verdict.ok) {
    // ⚠️ Only a genuine MISMATCH costs an attempt. Charging an expired or already-consumed
    // code would let a stale tab burn the budget for the code the customer is about to
    // request, locking them out of a login they are doing correctly.
    if (verdict.reason === "mismatch") {
      if (emailBucket) await saveBucket(sb, emailBucket, { fail: emailBucket.failCount + 1 });
      await sb.from("customer_email_otps")
        .update({ attempts: (row?.attempts ?? 0) + 1 })
        .eq("client_id", clientId).eq("email_lower", email);
    }
    return json({ error: MSG_EMAIL_CODE_BAD }, 401);
  }

  // Proven. Burn the code FIRST — a session minted against a code still marked live is a
  // replayable login, and this write failing is not a reason to hand out a second one.
  const { error: consumeErr } = await sb.from("customer_email_otps")
    .update({ consumed_at: new Date().toISOString() })
    .eq("client_id", clientId).eq("email_lower", email).is("consumed_at", null);
  if (consumeErr) {
    await logEdgeError({
      fn: "customer-auth", req, clientId, code: "email_otp_consume",
      message: `could not mark the email sign-in code used: ${consumeErr.message}`,
    });
    return json({ error: "Something went wrong signing you in — try again." }, 502);
  }
  if (emailBucket) await saveBucket(sb, emailBucket, { fail: 0 });

  // ── Resolve the address to the phone identity the portal is built on ────────────────
  // ⚠️ designs.contact IS A CLAIM, NOT EVIDENCE. Every design write goes through
  // save_design, which the anonymous designer may call, and the contact blob is stored
  // verbatim — so "a design in this tenant carries my address" says only that SOMEBODY typed
  // that pair, not that the number beside the address belongs to whoever proved the address.
  // Handing the newest such row's phone straight to mintSession would make the whole portal's
  // ownership model (customer-quotes, customer-accept and customer-pay all authorise on
  // phone_digits alone) rest on a field a stranger can write.
  //
  // The address must therefore resolve to a number this tenant's own records do not
  // CONTRADICT. Two rules, both cheap:
  //   1. only a design the customer would recognise as their quote may supply an identity.
  //      'inventory' is the builder's own stock and 'draft' is the silent capture a visitor
  //      never knowingly created — customer-quotes hides both, so neither could ever have
  //      produced a portal to sign in to.
  //   2. every other design carrying that same number must agree on the address. A number
  //      that already answers to a different address in this tenant is spoken for, and the
  //      honest answer is the noQuotes one below. A blank address claims nothing, so it
  //      never contradicts.
  // A number that fails rule 2 is skipped rather than fatal, so a customer who changed
  // number still falls through to the older one they own.
  //
  // Tenant-wide read, matched in code: PostgREST cannot state the normalize-to-digits
  // expression both sides of a phone comparison need (customer-quotes carries the same note),
  // and the limit(200) this replaces silently truncated a busy tenant's older designs into
  // the noQuotes answer.
  const { data: matches } = await sb.from("designs")
    .select("contact, created_at, status")
    .eq("client_id", clientId)
    .order("created_at", { ascending: false });
  // deno-lint-ignore no-explicit-any
  const designRows = (matches ?? []) as any[];
  const contactEmail = (c: Record<string, unknown>) => normalizeEmail(String(c.email ?? ""));
  const contactPhone = (c: Record<string, unknown>) => {
    const raw = String(c.phone ?? "").replace(/\D/g, "");
    return raw.length === 11 && raw.startsWith("1") ? raw.slice(1) : raw;
  };

  // Every address this tenant's designs carry for a given number, built in one pass so the
  // contradiction test below is a lookup rather than a rescan.
  const addressesByPhone = new Map<string, Set<string>>();
  for (const d of designRows) {
    if (d?.status === "inventory") continue;
    const c = (d?.contact ?? {}) as Record<string, unknown>;
    const ten = contactPhone(c);
    const addr = contactEmail(c);
    if (ten.length !== 10 || !addr) continue;
    const seen = addressesByPhone.get(ten);
    if (seen) seen.add(addr);
    else addressesByPhone.set(ten, new Set([addr]));
  }

  let digits = "";
  let foundName: string | null = null;
  for (const d of designRows) {
    if (d?.status === "draft" || d?.status === "inventory") continue;
    const c = (d?.contact ?? {}) as Record<string, unknown>;
    if (contactEmail(c) !== email) continue;
    const ten = contactPhone(c);
    if (ten.length !== 10) continue;
    // The matched design contributed this address itself, so more than one means another
    // address also answers to this number.
    if ((addressesByPhone.get(ten)?.size ?? 0) > 1) continue;
    digits = ten;
    foundName = typeof c.name === "string" && c.name.trim() ? c.name.trim().slice(0, 80) : null;
    break;
  }

  if (!digits) {
    // They proved the address; there is simply nothing filed under it. Saying so is safe HERE
    // — the enumeration rule governs the send path, and they have already proven control.
    // No session is minted: customer_sessions.phone_digits is NOT NULL, and inventing an
    // identity to satisfy a column would be a login as nobody.
    return json({
      ok: true,
      noQuotes: true,
      error: "That email is confirmed, but we don't have any quotes filed under it. " +
             "Try signing in with the phone number on your quote instead.",
    });
  }

  const token = await mintSession(sb, clientId, digits, name ?? foundName);
  return json({ ok: true, token, name: name ?? foundName });
}

