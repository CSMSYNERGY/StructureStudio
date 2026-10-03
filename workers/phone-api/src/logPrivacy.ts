// What an error report from the Chrome extension keeps when POST /log saves it (DEVIATIONS 64).
//
// The extension's privacy policy claims the Chrome Web Store's Limited Use rules: people here
// may read user data only with the user's consent, for security, to comply with the law, or
// aggregated and anonymised for running the service. So an extension report carries no direct
// identifier. It keeps:
//   - no client_id and no context.user_id. Instead `user_ref` and `client_ref`: an HMAC-SHA-256
//     of the id under the Worker secret LOG_PSEUDONYM_KEY, cut to 24 hex characters. One
//     person's repeated errors still group together, and when someone asks for help (consent)
//     scripts/log-ref.mjs turns THEIR id into the ref to look for. The key stops anyone
//     recomputing a ref from an id they hold. No key: no refs at all, never the raw id or an
//     unkeyed hash.
//   It is pseudonymous, NOT anonymous: a report's time and codes can be lined up with
//   phone_calls, which names the person. So these rows (and the Worker's own edge:phone-api
//   rows) are read only in summary unless the person consents, for security or for the law
//   (SETUP.md section 10). That rule is the policy's; nothing here can enforce it.
//   - only the context keys the extension is known to send (EXTENSION_CONTEXT_KEYS), scalar
//     values only. Any other key is dropped and only its name is listed in `dropped`, so a new
//     key from a newer build shows up as something to add here rather than vanishing quietly.
//   - message, code and every kept string with emails, phone numbers, uuids, Twilio identities
//     and SIDs (a call SID joins to phone_calls, which names the customer) and login tokens
//     replaced by "[redacted]".
// The mobile app's reports are unchanged.

/** The two source codes the Chrome extension sends (the second from builds before 2026-10-01). */
export const EXTENSION_LOG_SOURCES: ReadonlySet<string> = new Set(["my-synergy-phone-extension", "sss-phone-extension"]);

/**
 * Every context key the extension sends, from its logger.log / deps.log call sites (audited
 * 2026-10-03), plus the two the Worker writes for an oversized context. None of them is an id.
 */
const EXTENSION_CONTEXT_KEYS: ReadonlySet<string> = new Set([
  "where", // service-worker | offscreen | screen | device | call
  "repeats", // how many identical reports the logger folded into this one
  "code", // the plain-error code (bad_request, twilio_error, ...)
  "twilio_code", // the Voice SDK's numeric error code
  "reason", // why a health check ran (mic, offscreen-ready, ...)
  "type", // the internal message type that failed
  "surface", // which screen threw (popup, popout, welcome)
  "_truncated",
  "bytes",
]);

export const REDACTED = "[redacted]";

/** Hex characters kept from the HMAC: 96 bits, plenty to keep everyone apart. */
const REF_HEX = 24;
/** A shorter key is treated as missing: a guessable key would make the refs reversible. */
export const MIN_KEY_LENGTH = 32;
const MAX_STRING = 300;
const MAX_DROPPED = 10;

const enc = new TextEncoder();
/** The imported key, kept for the life of the isolate (the secret does not change under it). */
let cached: { secret: string; key: Promise<CryptoKey> } | null = null;

function hmacKey(secret: string): Promise<CryptoKey> {
  if (cached && cached.secret === secret) return cached.key;
  const key = crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const entry = { secret, key };
  cached = entry;
  key.catch(() => {
    if (cached === entry) cached = null; // a failed import is not kept
  });
  return key;
}

/** LOG_PSEUDONYM_KEY trimmed, or null when it is unset or too short to use. */
export function pseudonymKey(raw: string | undefined): string | null {
  const k = String(raw ?? "").trim();
  return k.length >= MIN_KEY_LENGTH ? k : null;
}

/**
 * The keyed pseudonym for one id: hex(HMAC-SHA-256(key, "<kind>:<id>")) cut to 24 characters.
 * A user id is a uuid and is lowercased; a client id (the tenant slug) is only trimmed.
 * scripts/log-ref.mjs computes the same thing with node:crypto; test/logPrivacy.test.ts holds
 * the two together.
 */
export async function logRef(key: string, kind: "user" | "client", id: string): Promise<string> {
  const norm = kind === "user" ? String(id).trim().toLowerCase() : String(id).trim();
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(key), enc.encode(`${kind}:${norm}`)));
  let hex = "";
  for (const b of sig) hex += b.toString(16).padStart(2, "0");
  return hex.slice(0, REF_HEX);
}

// Order matters: the specific shapes go first so a later, broader one cannot leave half of
// them behind (a uuid's last group is 12 digits; an identity is "u_" + 32 hex).
const SCRUB: RegExp[] = [
  // A Supabase login token (its payload carries the user id and email), from its header on,
  // so a token cut short still goes whole.
  /\beyJ[\w-]{4,}(?:\.[\w-]*){0,2}/g,
  // Emails, also URL-encoded (%40). The lookbehind starts a match only where a run of
  // address characters starts, which keeps a long run with no @ in it linear.
  /(?<![\w.+-])[\w.+-]+(?:@|%40)[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi,
  // A Twilio client identity: u_<user id without hyphens>_g<generation>[_dev].
  /\bu_[0-9a-f]{32}_g\d+(?:_dev)?/gi,
  // Twilio SIDs: two letters and 32 hex (CA call, SM/MM text, PN number, ...).
  /(?<![a-z0-9])[a-z]{2}[0-9a-f]{32}(?![a-z0-9])/gi,
  // uuids (users, contacts and so a saved customer's thread key, calls).
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
  // Any other run of 32 or more hex characters (a uuid without its hyphens).
  /[0-9a-f]{32,}/gi,
  // North American numbers however they are written: +1 555 555 0100, (555) 555-0100,
  // 5555550100, 15555550100. A longer digit run (a millisecond timestamp) is left alone.
  /(?<!\d)(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/g,
  // Any other E.164 number.
  /\+\d{8,15}(?!\d)/g,
];

/**
 * A string with every email, phone number, uuid, identity, SID and login token replaced, cut
 * to `max` characters AFTER scrubbing: cutting first could leave half a phone number behind,
 * too short for the patterns to know it. The input is cut to `max` + 2000 first, which keeps
 * the work bounded and still holds anything that crosses the final cut whole.
 */
export function scrubText(s: string, max = MAX_STRING): string {
  let out = String(s).slice(0, max + 2000);
  for (const re of SCRUB) out = out.replace(re, REDACTED);
  return out.slice(0, max);
}

/** The extension's context, cut down to the keys it is known to send, every string scrubbed. */
export function extensionContext(context: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(context)) {
    const scalar = v === null || typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));
    if (!EXTENSION_CONTEXT_KEYS.has(k) || !scalar) {
      if (dropped.length < MAX_DROPPED) dropped.push(scrubText(k, 40));
      continue;
    }
    out[k] = typeof v === "string" ? scrubText(v) : v;
  }
  if (dropped.length) out.dropped = dropped;
  return out;
}

/**
 * `user_ref` and `client_ref` for one report, or nothing when the key is unusable. A client
 * ref is left out when the person has no business (their phone access is gone).
 */
export async function reportRefs(rawKey: string | undefined, userId: string, clientId: string | null): Promise<Record<string, string>> {
  const key = pseudonymKey(rawKey);
  if (!key) return {};
  const refs: Record<string, string> = { user_ref: await logRef(key, "user", userId) };
  if (clientId) refs.client_ref = await logRef(key, "client", clientId);
  return refs;
}
