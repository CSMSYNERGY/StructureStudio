// Which Twilio account a request runs in (Workstream 2: one Twilio sub-account per builder).
//
// A WRAPPER over the shared resolver (supabase/functions/_shared/twilioAccount.ts), never a second
// copy of its rules: the edge functions and the Worker answer "which account" the same way.
//
//   twilioEnvFor   the tenant's (or an AccountSid's) account as a SCOPED Env: the same object with
//                  its TWILIO_* values replaced by that account's, so twilioRest.ts and
//                  accessToken.ts keep their signatures and simply read the Env they are given.
//   webhookEnv /   phase 4: the account a Twilio webhook came from rides on the Env its handler gets
//   tenantMatches  (TWILIO_WEBHOOK_ACCOUNT, an object, so the Deno.env shim never exposes it), and
//   Webhook        a handler that resolves a tenant refuses one that lives in another account
//                  (account_mismatch).
//
// ⚠️ SWITCH OFF = TODAY, EXACTLY. While TWILIO_SUBACCOUNTS is not "on", twilioEnvFor hands back the
// SAME env object and webhookEnv the same env, with no lookup; tenantMatchesWebhook answers true
// without one. One Worker serves every tenant on beta and production alike.
//
// ⚠️ NEVER THROUGH THE DENO SHIM. installDenoShim (env.ts) points the shared modules' Deno.env at
// the Worker's own env for the whole isolate; a tenant's credentials put there would be read by
// every concurrent request. They travel only as the scoped Env value below.

import type { Env } from "./env";
import type { Admin } from "./db";
import {
  accountBySid, resolveTwilioAccount, signedBySub, subaccountsOn, TwilioAccountError, webhookTenantVerdict,
  type AccountLookup, type TenantVerdict, type TwilioAccount, type WebhookAccount,
} from "../../../supabase/functions/_shared/twilioAccount.ts";

export { signedBySub, TwilioAccountError, type AccountLookup, type WebhookAccount };

/** The shared resolver's `get` over the Worker's env: string values only, like the Deno shim. */
export function envGet(env: Env): (k: string) => string | undefined {
  const source = env as unknown as Record<string, unknown>;
  return (k) => {
    const v = source[k];
    return typeof v === "string" ? v : undefined;
  };
}

export function subaccountsOnFor(env: Env): boolean {
  return subaccountsOn(envGet(env));
}

/**
 * An Env whose Twilio values are this account's. Every value that belongs to an account is
 * replaced, and one the sub does not have is CLEARED rather than left as the parent's: a token
 * signed with one account's key for another account's TwiML App or push credential is Twilio
 * error 31203. TWILIO_ECHO_APP_SID (the setup test) and everything not Twilio's stay as they are.
 */
export function scopedTwilioEnv(env: Env, acct: TwilioAccount): Env {
  const keyPair = acct.user !== acct.accountSid;
  return {
    ...env,
    TWILIO_ACCOUNT_SID: acct.accountSid,
    TWILIO_API_KEY: keyPair ? acct.user : undefined,
    TWILIO_API_SECRET: keyPair ? acct.pass : undefined,
    TWILIO_AUTH_TOKEN: acct.authToken ?? (keyPair ? undefined : acct.pass),
    TWILIO_TWIML_APP_SID: acct.twimlAppSid ?? undefined,
    TWILIO_PUSH_CREDENTIAL_APNS_DEV: acct.pushApnsDevSid ?? undefined,
    TWILIO_PUSH_CREDENTIAL_APNS_PROD: acct.pushApnsProdSid ?? undefined,
    TWILIO_PUSH_CREDENTIAL_FCM: acct.pushFcmSid ?? undefined,
  };
}

/**
 * The Env a tenant's (or an AccountSid's) Twilio calls run with. Switch off, a tenant on the
 * parent, or the parent's own SID: `env` itself. A sub: scopedTwilioEnv. Throws TwilioAccountError
 * (switch on only): a sub that is not active, an AccountSid that is not ours, or a lookup that
 * failed; the caller refuses that request and nobody else's is touched.
 */
export async function twilioEnvFor(env: Env, admin: Admin, who: { clientId: string } | { accountSid: string }): Promise<Env> {
  const get = envGet(env);
  if (!subaccountsOn(get)) return env;
  let clientId: string;
  if ("accountSid" in who) {
    const hook = await accountBySid(admin, who.accountSid, get);
    if (!hook) throw new TwilioAccountError("lookup_failed", "that AccountSid is not one of ours");
    if (hook.source === "parent" || !hook.clientId) return env;
    clientId = hook.clientId;
  } else {
    clientId = who.clientId;
  }
  const acct = await resolveTwilioAccount(admin, clientId, get);
  return acct && acct.source === "sub" ? scopedTwilioEnv(env, acct) : env;
}

/** For verifyTwilioRequest: the account an AccountSid names (the shared accountBySid), and the
 *  same again with `revalidate` when a sub's cached token did not validate. */
export function webhookAccountLookup(env: Env, admin: () => Admin): AccountLookup {
  return (sid, opts) => accountBySid(admin(), sid, envGet(env), Date.now(), opts);
}

/** The Env a verified webhook's handler runs with: the account it came from rides along (phase 4).
 *  No account (the switch off): `env` itself. */
export function webhookEnv(env: Env, account: WebhookAccount | undefined): Env {
  return account ? { ...env, TWILIO_WEBHOOK_ACCOUNT: account } : env;
}

/**
 * Does the tenant a handler just resolved live in the account the webhook came from? The shared
 * webhookTenantVerdict, the same answer the edge functions get: "ok" with no lookup while the
 * switch is off (no TWILIO_WEBHOOK_ACCOUNT). A sub's webhook may only touch its own tenant (no
 * lookup: the account row names it); the parent's only a tenant with no sub-account (one cached
 * read). A failed read is "lookup_failed": refused, never guessed.
 */
export function tenantVerdictForWebhook(env: Env, admin: Admin, clientId: string): Promise<TenantVerdict> {
  return webhookTenantVerdict(admin, env.TWILIO_WEBHOOK_ACCOUNT ?? null, clientId, envGet(env));
}

export async function tenantMatchesWebhook(env: Env, admin: Admin, clientId: string): Promise<boolean> {
  return (await tenantVerdictForWebhook(env, admin, clientId)) === "ok";
}
