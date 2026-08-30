/**
 * Email one-time codes for the customer quote portal — the second way in, so a Twilio
 * outage cannot lock every customer out of their own quotes.
 *
 * A leaf module with no imports, like twilioVerify.ts, so preflight can unit-test it offline.
 *
 * ⚠️ THIS MODULE HOLDS A SECRET THE SMS PATH NEVER HAD TO. Twilio Verify generates, delivers
 * and checks its own codes, which is why customer-auth can say codes are "never stored or
 * logged here, not even hashed". Running our own channel means we hold the code, so every
 * rule below exists to make holding it as close to harmless as possible:
 *
 *   * KEYED HASH, NOT A DIGEST. A bare sha256 of a 6-digit code is ~1,000,000 guesses —
 *     instant offline — so a read-only leak of customer_email_otps would hand over live
 *     codes. HMAC with a server-side key means the table alone is not enough.
 *   * The plaintext code exists only inside `issue()`'s return value, long enough to be put
 *     in an email. It is never returned by `verify()`, never stored, never logged.
 *   * Codes are compared in constant time. A timing oracle on a 6-digit secret is worth
 *     having: it turns 1,000,000 guesses into six independent 10-way guesses.
 *   * SINGLE USE and SHORT LIVED, enforced by the caller against the row this returns.
 */

/** Ten minutes. Long enough to switch to an email client and back on a phone, short enough
 *  that a code found later in a shared inbox is already dead. */
export const EMAIL_OTP_TTL_MS = 10 * 60_000;

/** Wrong guesses allowed against one issued code before it is dead. Deliberately tighter
 *  than the per-window fail budget: that one governs a whole 15-minute window across codes;
 *  this one bounds a single secret's exposure. Five guesses out of a million is nothing. */
export const EMAIL_OTP_MAX_ATTEMPTS = 5;

/**
 * The HMAC key.
 *
 * ⚠️ `SUPABASE_SERVICE_ROLE_KEY` is used as the key deliberately, and the reasoning matters:
 * an attacker who holds it can already read customer_email_otps AND customer_sessions
 * directly, so keying on it adds no NEW exposure — while defending the case that actually
 * differs, a read-only leak of this one table (a mis-scoped grant, a backup, a log). Adding a
 * dedicated secret would be marginally better and would also be one more thing to set before
 * login works, which is exactly the kind of step that gets skipped and then discovered by a
 * customer who cannot sign in.
 */
function hmacKeyMaterial(): string | null {
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || null;
}

export class EmailOtpNotConfigured extends Error {
  constructor(msg = "Email sign-in is not configured on this deployment.") {
    super(msg);
    this.name = "EmailOtpNotConfigured";
  }
}

/**
 * A 6-digit code from the CSPRNG, uniformly distributed.
 *
 * ⚠️ NOT `Math.random()`, and not `% 1000000` on a raw 32-bit draw either — the modulo of a
 * range that is not a whole multiple of 1,000,000 leaves the low codes very slightly more
 * likely. Rejection sampling costs nothing here and removes the bias argument entirely.
 */
export function generateEmailOtp(): string {
  const LIMIT = 1_000_000;
  const MAX = Math.floor(0xFFFFFFFF / LIMIT) * LIMIT; // largest unbiased draw
  const buf = new Uint32Array(1);
  let n: number;
  do {
    crypto.getRandomValues(buf);
    n = buf[0];
  } while (n >= MAX);
  return String(n % LIMIT).padStart(6, "0");
}

/**
 * Keyed hash of a code, bound to WHO it was issued for.
 *
 * ⚠️ The tenant and the address are part of the signed material, not just the code. Without
 * that binding, a code issued to one address would validate against another — and a code
 * issued on one tenant would work on another, which is a cross-tenant hole.
 */
export async function hashEmailOtp(clientId: string, emailLower: string, code: string): Promise<string> {
  const secret = hmacKeyMaterial();
  if (!secret) throw new EmailOtpNotConfigured();
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const material = `${clientId}\u0000${emailLower}\u0000${code}`;
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(material));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string compare. Same shape as twilioSms.validateTwilioSignature's: length
 *  first, then accumulate differences rather than returning early, so the comparison does not
 *  leak how long a matching prefix was. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Normalise an address to the ONE identity used for issuing, throttling and consuming.
 *
 * Lower-case and trim only. ⚠️ Deliberately NOT clever: no dot-stripping, no +tag removal.
 * Those are Gmail-specific conventions, they are wrong for most other providers, and
 * "canonicalising" two addresses into one here would let a code issued to one person be
 * consumed by another. The address the customer typed is the address we mean.
 */
export function normalizeEmail(raw: string): string {
  return String(raw ?? "").trim().toLowerCase();
}

/** Shape-check only. Deliverability is proven by the code arriving, not by a regex — the
 *  point of an OTP is that guessing the address is not enough. */
export function isPlausibleEmail(raw: string): boolean {
  const e = normalizeEmail(raw);
  if (e.length < 5 || e.length > 254) return false;
  if (/[\s<>,;"\\]/.test(e)) return false;          // header-injection characters
  return /^[^@]+@[^@.]+(\.[^@.]+)+$/.test(e);
}

export type IssuedOtp = { code: string; codeHash: string; expiresAt: Date };

/** Mint a code and everything needed to store it. The PLAINTEXT lives only in the return
 *  value, for exactly as long as it takes to put it in an email. */
export async function issueEmailOtp(clientId: string, emailLower: string): Promise<IssuedOtp> {
  const code = generateEmailOtp();
  return {
    code,
    codeHash: await hashEmailOtp(clientId, emailLower, code),
    expiresAt: new Date(Date.now() + EMAIL_OTP_TTL_MS),
  };
}

export type OtpVerdict =
  | { ok: true }
  | { ok: false; reason: "no_code" | "expired" | "consumed" | "too_many_attempts" | "mismatch" };

/**
 * Judge a submitted code against a stored row. Pure — the caller owns every read and write,
 * so this stays unit-testable without a database.
 *
 * ⚠️ Order matters. Expiry and consumption are checked BEFORE the comparison, so a dead code
 * never even reaches the compare — and the caller must not count a dead code as a failed
 * attempt, or an expired code would burn the budget for the fresh one the customer is about
 * to request.
 */
export async function verifyEmailOtp(
  clientId: string,
  emailLower: string,
  submitted: string,
  row: { code_hash: string; expires_at: string; attempts: number; consumed_at: string | null } | null,
  now: Date = new Date(),
): Promise<OtpVerdict> {
  if (!row) return { ok: false, reason: "no_code" };
  if (row.consumed_at) return { ok: false, reason: "consumed" };
  if (new Date(row.expires_at).getTime() <= now.getTime()) return { ok: false, reason: "expired" };
  if (row.attempts >= EMAIL_OTP_MAX_ATTEMPTS) return { ok: false, reason: "too_many_attempts" };
  const candidate = await hashEmailOtp(clientId, emailLower, submitted);
  return constantTimeEqual(candidate, row.code_hash) ? { ok: true } : { ok: false, reason: "mismatch" };
}

/** The email body. Plain and short on purpose: a login code that reads like marketing gets
 *  filtered, and a customer scanning a phone screen wants the digits first. */
export function emailOtpBody(brand: string, code: string): { subject: string; html: string; text: string } {
  const safeBrand = String(brand || "").replace(/[<>&]/g, "").trim() || "your builder";
  const subject = `${code} is your sign-in code`;
  const text =
    `Your sign-in code is ${code}\n\n` +
    `Enter it to see your quotes from ${safeBrand}. It expires in 10 minutes.\n\n` +
    `If you didn't ask to sign in, you can ignore this email — nobody can use this code without it.`;
  const html =
    `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:420px">` +
    `<p style="font-size:15px;color:#334155;margin:0 0 14px">Your sign-in code is</p>` +
    `<p style="font-size:34px;font-weight:800;letter-spacing:6px;margin:0 0 14px;color:#0F172A">${code}</p>` +
    `<p style="font-size:14px;color:#475569;margin:0 0 14px">` +
    `Enter it to see your quotes from ${safeBrand}. It expires in 10 minutes.</p>` +
    `<p style="font-size:12px;color:#94A3B8;margin:0">` +
    `If you didn't ask to sign in, you can ignore this email — nobody can use this code without it.</p>` +
    `</div>`;
  return { subject, html, text };
}
