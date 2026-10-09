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
//   envForClient / phase 5: every Twilio REST call runs in the account of the business it is for.
//   callerTwilio   A webhook's handler runs as the account the webhook came from (webhookEnv: a
//   Env /          sub's own SID + auth token, which the signature check already holds, so no
//   cronAccounts   lookup); an app route as the caller's business (callerTwilioEnv); a cron row as
//                  its row's business (envForClient), and the recording sweep lists every account
//                  (cronAccounts). /token mints with the sub's key, app and push credential
//                  (routes/token.ts). The setup test (TWILIO_ECHO_APP_SID) and NTS stay the parent's.
//
// ⚠️ SWITCH OFF = TODAY, EXACTLY. While TWILIO_SUBACCOUNTS is neither "on" nor "manual" (both use
// every existing sub-account here; only the edge's provisioning tells them apart), twilioEnvFor
// hands back the SAME env object and webhookEnv the same env, with no lookup;
// tenantMatchesWebhook answers true without one. One Worker serves every tenant on beta and
// production alike.
//
// ⚠️ NEVER THROUGH THE DENO SHIM. installDenoShim (env.ts) points the shared modules' Deno.env at
// the Worker's own env for the whole isolate; a tenant's credentials put there would be read by
// every concurrent request. They travel only as the scoped Env value below.

import type { Env } from "./env";
import type { Admin } from "./db";
import { ApiError } from "./http";
import { logFault } from "./log";
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
  const acct = await tenantAccount(env, admin, clientId, Date.now());
  return acct ? scopedTwilioEnv(env, acct) : env;
}

// ── Phase 5: every REST call in the account of the business it is for ──────────────────────

/** Per isolate: a tenant's resolved account (null = the parent). A sub 60 seconds (its key or
 *  status can change: twilio_account_secret_put, the console's Suspend), the parent 30 (a builder
 *  just given a sub is seen within that). Failures are never kept. Emptied at 1,000 entries. */
const ACCOUNT_TTL_MS = 60_000;
const PARENT_TTL_MS = 30_000;
const ACCOUNT_CACHE_MAX = 1000;
const accountCache = new Map<string, { until: number; acct: TwilioAccount | null }>();

/** Tests only. */
export function _resetWorkerTwilioCache(): void {
  accountCache.clear();
}

async function tenantAccount(env: Env, admin: Admin, clientId: string, now: number): Promise<TwilioAccount | null> {
  const key = String(clientId ?? "");
  const hit = accountCache.get(key);
  if (hit && hit.until > now) return hit.acct;
  const acct = await resolveTwilioAccount(admin, key, envGet(env));
  const sub = acct && acct.source === "sub" ? acct : null;
  if (accountCache.size >= ACCOUNT_CACHE_MAX && !accountCache.has(key)) accountCache.clear();
  accountCache.set(key, { until: now + (sub ? ACCOUNT_TTL_MS : PARENT_TTL_MS), acct: sub });
  return sub;
}

/**
 * The Env one business's Twilio REST calls run with. Switch off: `env` itself, nothing looked up
 * (today). On: the parent's env for a business on the parent, the sub's scoped Env for one with
 * its own. Throws TwilioAccountError (switch on only): that business's call is refused, nobody
 * else's is touched.
 */
export async function envForClient(env: Env, admin: Admin, clientId: string, now: number = Date.now()): Promise<Env> {
  if (!subaccountsOnFor(env)) return env;
  const acct = await tenantAccount(env, admin, clientId, now);
  return acct ? scopedTwilioEnv(env, acct) : env;
}

/**
 * An app route's Env: the signed-in caller's business's account. Switch off: `env` itself. A sub
 * still being set up is a refusal the apps can show; a lookup that fails is logged and refused.
 */
export async function callerTwilioEnv(env: Env, c: { admin: Admin; ctx: { client_id: string } }): Promise<Env> {
  try {
    return await envForClient(env, c.admin, c.ctx.client_id);
  } catch (e) {
    if (!(e instanceof TwilioAccountError)) throw e;
    if (e.kind === "not_ready") throw new ApiError("twilio_error", "Your phone account is still being set up. Try again in a few minutes.");
    await logFault({
      code: "twilio_account_lookup_failed", clientId: c.ctx.client_id, throttleMs: 60_000,
      message: `The business's Twilio account could not be resolved: ${e.message}`,
    }).catch(() => {});
    throw new ApiError("twilio_error");
  }
}

/** At most this many sub-accounts are asked per cron run (review L4). With more, they take turns:
 *  each run asks a different slice, in client_id order, so a run's subrequests stay bounded however
 *  many builders there are. The sweep lists a day back, so a sub asked every few 15-minute runs
 *  still has every message filed (fine up to CRON_SUBS_PER_RUN × 96 subs). */
export const CRON_SUBS_PER_RUN = 40;
/** How often the sweep runs: the turn changes once per period. */
export const CRON_PERIOD_MS = 15 * 60_000;

/**
 * Every account a cron that LISTS (the recording sweep) has to ask: the parent always, and with
 * the switch on each ACTIVE sub-account as its own scoped Env (CRON_SUBS_PER_RUN at a time, in
 * turns). Off: the parent alone, nothing looked up. A sub that cannot be resolved is left out and
 * logged; the parent is never dropped.
 */
export async function cronAccounts(
  env: Env, admin: Admin, opts: { now?: number; max?: number } = {},
): Promise<{ env: Env; clientId: string | null }[]> {
  const out: { env: Env; clientId: string | null }[] = [{ env, clientId: null }];
  if (!subaccountsOnFor(env)) return out;
  const { data, error } = await admin.from("twilio_accounts").select("client_id").eq("kind", "sub").eq("status", "active");
  if (error) {
    await logFault({
      code: "twilio_accounts_list_failed", throttleMs: 60 * 60_000,
      message: `Listing the active sub-accounts failed (${(error as { code?: string }).code ?? "no code"}); only the parent was asked.`,
    }).catch(() => {});
    return out;
  }
  const all = [...((data as { client_id: string }[] | null) ?? [])].sort((a, b) => String(a.client_id).localeCompare(String(b.client_id)));
  const max = Math.max(1, opts.max ?? CRON_SUBS_PER_RUN);
  const turns = Math.ceil(all.length / max);
  const turn = turns > 1 ? Math.floor((opts.now ?? Date.now()) / CRON_PERIOD_MS) % turns : 0;
  for (const r of all.slice(turn * max, turn * max + max)) {
    try {
      const scoped = await envForClient(env, admin, r.client_id);
      if (scoped !== env) out.push({ env: scoped, clientId: r.client_id });
    } catch (e) {
      await logFault({
        code: "twilio_account_lookup_failed", clientId: r.client_id, throttleMs: 60 * 60_000,
        message: `A sub-account was left out of a cron run: ${(e as Error).message}`,
      }).catch(() => {});
    }
  }
  return out;
}

/** For verifyTwilioRequest: the account an AccountSid names (the shared accountBySid), and the
 *  same again with `revalidate` when a sub's cached token did not validate. */
export function webhookAccountLookup(env: Env, admin: () => Admin): AccountLookup {
  return (sid, opts) => accountBySid(admin(), sid, envGet(env), Date.now(), opts);
}

/**
 * The Env a verified webhook's handler runs with. No account (the switch off): `env` itself.
 * Otherwise the account it came from rides along (phase 4), and for a SUB its REST calls run in
 * the sub (phase 5): a webhook is about a call, a recording or a conference in the account that
 * sent it, and those can only be reached with that account's own credentials. The sub's SID and
 * auth token are what the signature check already verified with, so this needs no lookup; its
 * key, app and push credentials are cleared (only /token uses them). The parent's: its env.
 */
export function webhookEnv(env: Env, account: WebhookAccount | undefined): Env {
  if (!account) return env;
  const withAccount: Env = { ...env, TWILIO_WEBHOOK_ACCOUNT: account };
  if (account.source !== "sub" || !account.authToken) return withAccount;
  return scopedTwilioEnv(withAccount, {
    ...account, user: account.accountSid, pass: account.authToken,
    twimlAppSid: null, pushApnsDevSid: null, pushApnsProdSid: null, pushFcmSid: null,
  });
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
