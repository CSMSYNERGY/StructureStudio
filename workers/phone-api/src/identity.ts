// Twilio client identities and phone numbers.
//
// ⚠️ A TWIN of @sss/phone-core's identity.ts and e164.ts (the private phone repo), kept here
// because this repo is public and cannot depend on that one. test/phoneCoreParity.test.ts
// compares the two whenever PHONE_CORE_DIR points at a checkout of the phone repo. The rule
// itself is fixed by SPEC section 1: u_<user_id without hyphens>_g<generation>, plus _dev for
// iPhone development-profile builds only.

const IDENTITY_RE = /^u_([0-9a-f]{32})_g(\d+)(_dev)?$/;

export interface ParsedIdentity {
  userId: string;
  generation: number;
  dev: boolean;
}

export function toIdentity(userId: string, generation: number, dev = false): string {
  const hex = String(userId).replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error("toIdentity: not a uuid");
  if (!Number.isInteger(generation) || generation < 1) throw new Error("toIdentity: bad generation");
  return `u_${hex}_g${generation}${dev ? "_dev" : ""}`;
}

export function parseIdentity(identity: string): ParsedIdentity | null {
  const m = IDENTITY_RE.exec(identity || "");
  if (!m) return null;
  const h = m[1];
  const userId = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  const generation = Number(m[2]);
  if (!Number.isSafeInteger(generation) || generation < 1) return null;
  return { userId, generation, dev: Boolean(m[3]) };
}

/** Twilio sends client identities as "client:<identity>" in From/To. */
export function stripClientPrefix(value: string): string {
  const v = String(value ?? "");
  return v.startsWith("client:") ? v.slice(7) : v;
}

const EMERGENCY = new Set(["911", "933", "112"]);

/** 911, 933 (Twilio's test number) and 112, however they were typed. */
export function emergencyDigits(input: string | null | undefined): string | null {
  const digits = String(input ?? "").replace(/\D/g, "");
  return EMERGENCY.has(digits) ? digits : null;
}

/**
 * A typed or stored number as +1XXXXXXXXXX, or null when it isn't a complete North American
 * number. Emergency numbers return null so they can never take the normal dialing path.
 */
export function toE164(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = String(input).trim();
  if (emergencyDigits(trimmed)) return null;
  const digits = trimmed.replace(/\D/g, "");
  let national: string;
  if (digits.length === 10) national = digits;
  else if (digits.length === 11 && digits.startsWith("1")) national = digits.slice(1);
  else return null;
  // NANP: neither the area code nor the exchange can start with 0 or 1.
  if (/^[01]/.test(national) || /^[01]/.test(national.slice(3))) return null;
  return `+1${national}`;
}

/** The ten-digit key Structure Studio stores as crm_contacts.phone_digits. */
export function phoneDigits(input: string | null | undefined): string | null {
  const e = toE164(input);
  return e ? e.slice(2) : null;
}

/**
 * Premium-rate NANP numbers: area code 900, and the 976 exchange in any area code. Twilio's geo
 * permissions (US and Canada only, premium blocked) are the main toll-fraud guard; this is the
 * second lock, so a console setting that drifts does not open the pay-per-minute lines.
 */
export function isPremiumRate(e164: string): boolean {
  return /^\+1900/.test(e164) || /^\+1\d{3}976/.test(e164);
}
