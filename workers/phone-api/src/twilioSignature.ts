// Is this request really from Twilio, for us?
//
// Two locks on every Twilio endpoint:
//   1. `?key=` equals PHONE_WEBHOOK_SECRET. Every URL the Worker hands Twilio carries it.
//      ALWAYS required: without the secret the Worker refuses every Twilio request (503).
//   2. X-Twilio-Signature: base64 HMAC-SHA1, keyed with the account's AUTH TOKEN, over the FULL
//      URL Twilio requested (query string included, unsorted) followed by every POST parameter
//      as name then value, sorted by name. Required WHENEVER TWILIO_AUTH_TOKEN is set.
//
// ⚠️ A MISSING TWILIO_AUTH_TOKEN IS A KNOWN STATE, NOT A FAULT (changed 09-29, DEVIATIONS 30).
// Twilio's API never returns the auth token, so a Worker set up from API credentials alone
// may start without it. It then accepts a webhook on the ?key= secret alone (`signed: false`),
// and the router logs `twilio_signature_skipped` at warn once per isolate so it is never
// silent. The SPEC's "refuse everything" would have made the whole phone line depend on a
// value nobody can fetch. What a forged request could do with the key alone is written up in
// DEVIATIONS 30; set the token as soon as it is known.
//
// The token is the only key that validates: an API key pair cannot (see _shared/twilioSms.ts).
//
// ── PER ACCOUNT (Workstream 2, phase 4), ONLY WHILE TWILIO_SUBACCOUNTS IS "on" ─────────────────
// Each builder's sub-account signs its own webhooks with ITS auth token, so the token is picked by
// the request's AccountSid:
//   the parent's SID (or none)    the parent's token, and the signature is MANDATORY: there is no
//                                 key-only state once sub-accounts exist (an unsigned request naming
//                                 the parent could otherwise reach a sub's business through any
//                                 callback that does not check the tenant). No parent token:
//                                 parent_token_missing, refused (503, an error: ours to fix)
//   a known ACTIVE sub-account    that sub's token, mandatory too (asked once more if the cached
//                                 token fails: a rotated token)
//   anything else                 wrong_account
// The account is looked up through the shared resolver (src/twilioAccount.ts, cached per
// isolate); a lookup that fails refuses the request (account_lookup_failed). The handlers then
// refuse a tenant that lives in another account than the one that sent the request
// (twilioAccount.ts tenantMatchesWebhook, account_mismatch). With the switch off none of this
// runs: verifyTwilioRequest is the parent check alone, unchanged (key-only included), and
// nothing is looked up.

import type { Env } from "./env";
import { safeEqual } from "./http";
import { signedBySub, subaccountsOnFor, type AccountLookup, type WebhookAccount } from "./twilioAccount";

export type TwilioParams = Record<string, string>;

export type TwilioCheck =
  /** `signed` is false when TWILIO_AUTH_TOKEN is unset and only ?key= was checked. `account` is
   *  the account the request came from, present only while TWILIO_SUBACCOUNTS is "on". */
  | { ok: true; params: TwilioParams; signed: boolean; account?: WebhookAccount }
  | {
    ok: false;
    reason: "no_webhook_secret" | "bad_key" | "no_signature" | "bad_signature" | "wrong_account" | "account_lookup_failed"
      | "parent_token_missing";
  };

function b64(bytes: ArrayBuffer): string {
  let s = "";
  const u = new Uint8Array(bytes);
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
}

/** The signature Twilio would send for this URL and these POST parameters. */
export async function computeTwilioSignature(
  authToken: string,
  url: string,
  params: [string, string][],
): Promise<string> {
  // Sorted by name, then by value for a repeated name (what Twilio's own libraries do).
  const sorted = [...params].sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
  const data = url + sorted.map(([k, v]) => k + v).join("");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(authToken),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  return b64(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
}

/**
 * The URLs Twilio may have signed. Twilio signs the URL it requested, which is req.url as the
 * Worker receives it. The same path on PUBLIC_BASE_URL is also accepted, because that is the
 * URL written into the console and into every callback we build; the two differ only while
 * requests arrive on workers.dev before the phone. route exists.
 */
function candidateUrls(env: Env, req: Request): string[] {
  const u = new URL(req.url);
  const out = [req.url];
  const base = String(env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  if (base) {
    const alt = `${base}${u.pathname}${u.search}`;
    if (!out.includes(alt)) out.push(alt);
  }
  return out;
}

/** Is `signature` this token's signature over any URL Twilio may have signed? Every candidate is
 *  computed and compared in full; no early exit on the first mismatch. */
async function signedWith(env: Env, req: Request, token: string, pairs: [string, string][], signature: string): Promise<boolean> {
  let matched = false;
  for (const candidate of candidateUrls(env, req)) {
    const expected = await computeTwilioSignature(token, candidate, pairs);
    if (safeEqual(expected, signature)) matched = true;
  }
  return matched;
}

/**
 * Check the key and the signature, and hand back the POST parameters. Reads the body; the
 * caller must not read it again.
 *
 * `opts.accountBySid` (the router's, over the shared resolver) is consulted ONLY while
 * TWILIO_SUBACCOUNTS is "on"; otherwise this is the parent check below, unchanged.
 */
export async function verifyTwilioRequest(
  env: Env,
  req: Request,
  opts: { accountBySid?: AccountLookup } = {},
): Promise<TwilioCheck> {
  if (opts.accountBySid && subaccountsOnFor(env)) return verifyPerAccount(env, req, opts.accountBySid);
  return verifyParent(env, req);
}

/** The check every webhook had before sub-accounts, and still has while the switch is off. */
async function verifyParent(env: Env, req: Request): Promise<TwilioCheck> {
  const secret = env.PHONE_WEBHOOK_SECRET || "";
  if (!secret) return { ok: false, reason: "no_webhook_secret" };

  const url = new URL(req.url);
  if (!safeEqual(url.searchParams.get("key") ?? "", secret)) return { ok: false, reason: "bad_key" };

  const token = env.TWILIO_AUTH_TOKEN || "";
  const signature = req.headers.get("x-twilio-signature") ?? "";
  // With a token, a missing signature is refused before the body is read.
  if (token && !signature) return { ok: false, reason: "no_signature" };

  const bodyText = req.method === "POST" ? await req.text() : "";
  const pairs = [...new URLSearchParams(bodyText).entries()];

  if (token) {
    let matched = false;
    for (const candidate of candidateUrls(env, req)) {
      // Every candidate is computed and compared in full; no early exit on the first mismatch.
      const expected = await computeTwilioSignature(token, candidate, pairs);
      if (safeEqual(expected, signature)) matched = true;
    }
    if (!matched) return { ok: false, reason: "bad_signature" };
  }

  const params: TwilioParams = {};
  for (const [k, v] of pairs) if (!(k in params)) params[k] = v;

  // A valid signature from ANOTHER Twilio account cannot happen with our token, but the
  // account id is on every request Twilio sends and costs nothing to pin. Without a token it
  // must be PRESENT and ours: one more thing a forger has to know besides the key.
  if (env.TWILIO_ACCOUNT_SID) {
    const acct = params.AccountSid;
    if ((acct || !token) && acct !== env.TWILIO_ACCOUNT_SID) return { ok: false, reason: "wrong_account" };
  }
  return { ok: true, params, signed: !!token };
}

/** TWILIO_SUBACCOUNTS "on": the token is the one of the account the request names (see the header). */
async function verifyPerAccount(
  env: Env, req: Request, accountBySid: AccountLookup,
): Promise<TwilioCheck> {
  const secret = env.PHONE_WEBHOOK_SECRET || "";
  if (!secret) return { ok: false, reason: "no_webhook_secret" };
  const url = new URL(req.url);
  if (!safeEqual(url.searchParams.get("key") ?? "", secret)) return { ok: false, reason: "bad_key" };

  const signature = req.headers.get("x-twilio-signature") ?? "";
  const bodyText = req.method === "POST" ? await req.text() : "";
  const pairs = [...new URLSearchParams(bodyText).entries()];
  const params: TwilioParams = {};
  for (const [k, v] of pairs) if (!(k in params)) params[k] = v;
  const acct = params.AccountSid ?? "";
  const parentSid = env.TWILIO_ACCOUNT_SID || "";

  // The parent (or no AccountSid at all): the parent check, SIGNED. Once sub-accounts exist the
  // parent's key-only state (DEVIATIONS 30) would let anyone holding the shared ?key= name the
  // parent's AccountSid and reach a sub's business through the callbacks that do not check the
  // tenant (all but /voice/inbound and /voice/outbound until phase 5). So with the switch on and no
  // parent token, the parent's webhooks are refused (parent_token_missing, our misconfiguration:
  // set TWILIO_AUTH_TOKEN before turning the switch on).
  if (!acct || acct === parentSid) {
    const token = env.TWILIO_AUTH_TOKEN || "";
    if (!token) return { ok: false, reason: "parent_token_missing" };
    if (!signature) return { ok: false, reason: "no_signature" };
    if (!(await signedWith(env, req, token, pairs, signature))) return { ok: false, reason: "bad_signature" };
    // Here the AccountSid is the parent's or absent, which the parent check accepts once signed.
    return { ok: true, params, signed: true, account: { source: "parent", accountSid: parentSid || acct, clientId: null, authToken: token } };
  }

  // Anyone else must be one of our ACTIVE sub-accounts, and must sign with its token: the cached
  // one, or (if that fails) the one Vault holds now, asked once more (a rotated token).
  let account: WebhookAccount | null;
  try {
    account = await accountBySid(acct);
  } catch {
    return { ok: false, reason: "account_lookup_failed" };
  }
  if (!account || account.source !== "sub" || account.accountSid !== acct || !account.authToken) {
    return { ok: false, reason: "wrong_account" };
  }
  if (!signature) return { ok: false, reason: "no_signature" };
  const signed = await signedBySub(account, accountBySid, (token) => signedWith(env, req, token, pairs, signature));
  if (!signed) return { ok: false, reason: "bad_signature" };
  return { ok: true, params, signed: true, account: signed };
}
