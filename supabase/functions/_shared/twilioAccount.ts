/**
 * Which Twilio account a business's texting and calling run in, and that account's credentials
 * (Workstream 2, phases 2 and 4: one Twilio sub-account per builder, ISV architecture #1).
 *
 * THE SWITCH. Until TWILIO_SUBACCOUNTS is exactly "on" (an edge secret, and a phone-api Worker var
 * of the same name), every tenant is on the PARENT account and nothing here touches the database:
 * resolveTwilioAccount answers parentCreds() from the environment, the credentials every Twilio
 * call used before this file existed. One Supabase project serves beta and production and the
 * Worker serves everyone, so "off" has to be exactly today, with no extra lookup on any path.
 *
 * With it on (migration 292's twilio_accounts, read through twilio_account_creds):
 *   no row, or kind 'parent'          → the parent (the environment)
 *   kind 'sub', status 'active'       → the sub's SID and its credentials from Vault
 *   kind 'sub', any other status      → TwilioAccountError "not_ready"
 *   the lookup itself fails           → TwilioAccountError "lookup_failed": that tenant's Twilio
 *                                       work stops (fail closed); nobody else's is touched
 *
 * Stays on the parent whatever the switch says: structure-studio (the pilot), Verify, the
 * setup-test app and NTS. A tenant with no row is on the parent (292 also pins every tenant that
 * already held something there with a kind 'parent' row, which answers the same).
 *
 * ONE TENANT, ONE ACCOUNT. Everything here is per tenant, never per number: that holds because the
 * database refuses a sub row for a tenant that still has anything on the parent (292's
 * twilio_accounts_no_split), so a tenant's numbers and registration are always in the one account
 * this file names for it.
 *
 * Zero imports: smsSend.ts imports this file and smsSend.ts is bundled into the phone-api Worker
 * (workers/phone-api/src/twilioAccount.ts wraps it rather than keeping a second copy). No Deno.*
 * either: the environment comes in as `get`.
 *
 * ⚠️ PER-TENANT CREDENTIALS NEVER GO THROUGH THE ENVIRONMENT. The Worker's Deno.env shim (env.ts
 * installDenoShim) is shared by every request in an isolate. What is resolved here is handed, as
 * a value, to whoever makes the Twilio call.
 *
 * ⚠️ NOTHING HERE IS LOGGED OR RETURNED TO A BROWSER: the secrets stay in the values below.
 */

export type EnvGet = (name: string) => string | undefined | null;

/** An account SID for the /Accounts/{sid} path, and the Basic pair every request carries: the API
 *  key pair when there is one, else AccountSid:AuthToken. Same shape portal-settings'
 *  phoneNumber.ts and twilioTrustHub.ts's TrustHubCreds take. */
export type TwilioCreds = { accountSid: string; user: string; pass: string };

/** Who a webhook came from: enough to check its signature and its tenant. */
export type WebhookAccount = {
  source: "parent" | "sub";
  accountSid: string;
  /** The tenant a sub belongs to. null for the parent, which is shared. */
  clientId: string | null;
  /** What X-Twilio-Signature is keyed with. The parent's may be unset (a known state: the Worker's
   *  DEVIATIONS 30, sms-inbound's three-state check); a sub's never is. */
  authToken: string | null;
};

/** One account to run as. The sub's own resources ride along for the Worker (phase 5); on the
 *  parent they are null, because the parent's are the environment's. */
export type TwilioAccount = TwilioCreds & WebhookAccount & {
  twimlAppSid: string | null;
  pushApnsDevSid: string | null;
  pushApnsProdSid: string | null;
  pushFcmSid: string | null;
};

export class TwilioAccountError extends Error {
  /** not_ready: the tenant has a sub-account that is not active (provisioning, suspended, closed,
   *  failed). lookup_failed: the database or Vault did not answer, or answered a sub with no usable
   *  credentials. Either way nothing is sent on that tenant's behalf. */
  readonly kind: "not_ready" | "lookup_failed";
  /** The row's status for not_ready, else null. */
  readonly accountStatus: string | null;
  constructor(kind: "not_ready" | "lookup_failed", message: string, accountStatus: string | null = null) {
    super(message);
    this.name = "TwilioAccountError";
    this.kind = kind;
    this.accountStatus = accountStatus;
  }
}

const ACCOUNT_SID = /^AC[0-9a-f]{32}$/i;

/** Exactly "on", like the Worker's other rails (CALL_RECORDING, CALL_TRANSCRIBE). */
export function subaccountsOn(get: EnvGet): boolean {
  return get("TWILIO_SUBACCOUNTS") === "on";
}

/**
 * The parent account's credentials from the environment, or null when they are not configured.
 * The one copy: twilioTrustHub.ts's basicAuthPair and twilioSms.ts's read the same names in the
 * same order (an API key pair first, then the account's auth token), and portal-settings'
 * phoneNumber.ts kept a duplicate of this until phase 2 moved it here.
 */
export function parentCreds(get: EnvGet): TwilioCreds | null {
  const accountSid = String(get("TWILIO_ACCOUNT_SID") ?? "");
  if (!accountSid) return null;
  const key = String(get("TWILIO_API_KEY") ?? ""), secret = String(get("TWILIO_API_SECRET") ?? "");
  if (key && secret) return { accountSid, user: key, pass: secret };
  const token = String(get("TWILIO_AUTH_TOKEN") ?? "");
  if (token) return { accountSid, user: accountSid, pass: token };
  return null;
}

function parentAccount(get: EnvGet): TwilioAccount | null {
  const c = parentCreds(get);
  if (!c) return null;
  return {
    ...c, source: "parent", clientId: null, authToken: String(get("TWILIO_AUTH_TOKEN") ?? "") || null,
    twimlAppSid: null, pushApnsDevSid: null, pushApnsProdSid: null, pushFcmSid: null,
  };
}

/** twilio_account_creds' row (migration 292). */
type CredsRow = {
  client_id?: string | null; kind?: string | null; account_sid?: string | null; status?: string | null;
  api_key_sid?: string | null; api_secret?: string | null; auth_token?: string | null;
  twiml_app_sid?: string | null; push_apns_dev_sid?: string | null; push_apns_prod_sid?: string | null;
  push_fcm_sid?: string | null;
};

// deno-lint-ignore no-explicit-any
async function credsRow(admin: any, args: { p_client_id: string } | { p_account_sid: string }): Promise<CredsRow | null> {
  // deno-lint-ignore no-explicit-any
  let res: any;
  try {
    res = await admin.rpc("twilio_account_creds", args);
  } catch (e) {
    throw new TwilioAccountError("lookup_failed", `twilio_account_creds did not answer: ${(e as Error)?.message ?? "unknown"}`);
  }
  if (res?.error) {
    // The code only (42883 = migration 292 not applied): a PostgREST message can carry arguments.
    throw new TwilioAccountError("lookup_failed", `twilio_account_creds failed (${String(res.error.code ?? "no code")})`);
  }
  const rows = Array.isArray(res?.data) ? res.data : res?.data ? [res.data] : [];
  return (rows[0] ?? null) as CredsRow | null;
}

/** A sub row as credentials: its SID on the path, its API key pair (else its auth token) on the wire. */
function subAccount(row: CredsRow): TwilioAccount {
  const accountSid = String(row.account_sid ?? "");
  if (!ACCOUNT_SID.test(accountSid)) {
    throw new TwilioAccountError("lookup_failed", "an active sub-account has no account SID");
  }
  const key = String(row.api_key_sid ?? ""), secret = String(row.api_secret ?? "");
  const token = String(row.auth_token ?? "");
  const pair = key && secret ? { user: key, pass: secret } : token ? { user: accountSid, pass: token } : null;
  if (!pair) throw new TwilioAccountError("lookup_failed", "an active sub-account has no credentials in Vault");
  return {
    accountSid, ...pair, source: "sub", clientId: row.client_id ? String(row.client_id) : null,
    authToken: token || null,
    twimlAppSid: row.twiml_app_sid ? String(row.twiml_app_sid) : null,
    pushApnsDevSid: row.push_apns_dev_sid ? String(row.push_apns_dev_sid) : null,
    pushApnsProdSid: row.push_apns_prod_sid ? String(row.push_apns_prod_sid) : null,
    pushFcmSid: row.push_fcm_sid ? String(row.push_fcm_sid) : null,
  };
}

/**
 * The account a tenant's Twilio calls run as. null = the parent is not configured on this
 * deployment (the switch off, or a tenant on the parent): the caller's "not switched on" answer,
 * exactly what an unset TWILIO_ACCOUNT_SID meant before. Throws TwilioAccountError (switch on only).
 *
 * ⚠️ OFF MEANS NO DATABASE. The first line is the whole answer while TWILIO_SUBACCOUNTS is not
 * "on"; twilioAccount.test.ts pins that `admin` is never touched.
 */
// deno-lint-ignore no-explicit-any
export async function resolveTwilioAccount(admin: any, clientId: string, get: EnvGet): Promise<TwilioAccount | null> {
  if (!subaccountsOn(get)) return parentAccount(get);
  const row = await credsRow(admin, { p_client_id: String(clientId ?? "") });
  if (!row || row.kind !== "sub") return parentAccount(get);
  if (row.status !== "active") {
    throw new TwilioAccountError("not_ready", `this tenant's Twilio account is ${String(row.status ?? "unknown")}`, String(row.status ?? "") || null);
  }
  return subAccount(row);
}

// ── Webhooks: which account sent this, and is it the tenant's? ─────────────────────────────

/** Per isolate. A known active sub's webhook account is kept 60 seconds: short, because it carries
 *  the sub's auth token (rotated by twilio_account_secret_put) and its status (a suspended sub must
 *  stop being accepted promptly). A failed signature also asks again at once (signedBySub), so a
 *  rotation costs at most one refused webhook per isolate. An unknown SID is kept 30 seconds. A
 *  tenant's account SID is kept 5 minutes: it never changes once chosen. Failures are never kept.
 *  Each map is emptied once it reaches CACHE_MAX entries: the AccountSid is the requester's
 *  choice (after the shared key), so the cache must not grow with whatever it is sent. */
const SUB_TTL_MS = 60_000;
const MISS_TTL_MS = 30_000;
const TENANT_TTL_MS = 5 * 60_000;
/** A revalidation inside this long of the last lookup answers from the cache: a burst of bad
 *  signatures for one SID cannot turn into a burst of Vault reads. */
const REVALIDATE_MIN_MS = 15_000;
const CACHE_MAX = 1000;
const bySidCache = new Map<string, { until: number; at: number; account: WebhookAccount | null }>();
const tenantCache = new Map<string, { until: number; sid: string | null }>();

function remember<V>(cache: Map<string, V>, key: string, value: V): void {
  if (cache.size >= CACHE_MAX && !cache.has(key)) cache.clear();
  cache.set(key, value);
}

/** Tests only: forget every cached answer. */
export function _resetTwilioAccountCaches(): void {
  bySidCache.clear();
  tenantCache.clear();
}

/** Tests only: how many answers each cache holds. */
export function _twilioAccountCacheSizes(): { bySid: number; tenant: number } {
  return { bySid: bySidCache.size, tenant: tenantCache.size };
}

/**
 * The account a webhook's AccountSid names, if it is one of ours:
 *   the parent (TWILIO_ACCOUNT_SID)      → the parent, from the environment, no lookup
 *   switch off                           → null, no lookup (callers keep today's check)
 *   an ACTIVE sub with its auth token    → that sub
 *   anything else                        → null (the caller answers wrong_account)
 * Throws TwilioAccountError "lookup_failed" when the lookup fails: the caller refuses the request.
 * `revalidate`: ask the database again even inside the cache's lifetime (after a signature failed
 * against the cached token), unless the cached answer is itself under REVALIDATE_MIN_MS old.
 */
export async function accountBySid(
  // deno-lint-ignore no-explicit-any
  admin: any, sid: string, get: EnvGet, now: number = Date.now(), opts: { revalidate?: boolean } = {},
): Promise<WebhookAccount | null> {
  const s = String(sid ?? "").trim();
  if (!ACCOUNT_SID.test(s)) return null;
  const parent = String(get("TWILIO_ACCOUNT_SID") ?? "");
  if (parent && s === parent) {
    return { source: "parent", accountSid: s, clientId: null, authToken: String(get("TWILIO_AUTH_TOKEN") ?? "") || null };
  }
  if (!subaccountsOn(get)) return null;
  const hit = bySidCache.get(s);
  if (hit && hit.until > now && (!opts.revalidate || now - hit.at < REVALIDATE_MIN_MS)) return hit.account;
  const row = await credsRow(admin, { p_account_sid: s });
  const token = String(row?.auth_token ?? "");
  const account: WebhookAccount | null = row && row.kind === "sub" && row.status === "active" && token
      && String(row.account_sid ?? "") === s
    ? { source: "sub", accountSid: s, clientId: row.client_id ? String(row.client_id) : null, authToken: token }
    : null;
  remember(bySidCache, s, { until: now + (account ? SUB_TTL_MS : MISS_TTL_MS), at: now, account });
  return account;
}

/** How a caller asks for an account again: accountBySid with `revalidate`, over its own client. */
export type AccountLookup = (sid: string, opts?: { revalidate?: boolean }) => Promise<WebhookAccount | null>;

/**
 * Was this webhook signed by this sub-account? `check(token)` is the caller's own signature check
 * (twilioSms.ts validateTwilioSignature on the edge, twilioSignature.ts on the Worker). The cached
 * token first; if it does not validate, the account is looked up ONCE more (a rotated token, or a
 * sub suspended since it was cached) and checked with what comes back. Answers the account it
 * validated with, or null: refused. A lookup that fails on the second try is null too.
 */
export async function signedBySub(
  account: WebhookAccount, lookup: AccountLookup, check: (token: string) => Promise<boolean>,
): Promise<WebhookAccount | null> {
  if (account.source !== "sub" || !account.authToken) return null;
  if (await check(account.authToken)) return account;
  let fresh: WebhookAccount | null;
  try {
    fresh = await lookup(account.accountSid, { revalidate: true });
  } catch {
    return null;
  }
  if (!fresh || fresh.source !== "sub" || fresh.accountSid !== account.accountSid || !fresh.authToken) return null;
  if (fresh.authToken === account.authToken) return null;
  return (await check(fresh.authToken)) ? fresh : null;
}

export type RequestAccount =
  /** TWILIO_SUBACCOUNTS is not "on": the caller runs the check it always ran, nothing was looked up. */
  | { kind: "off" }
  | { kind: "account"; account: WebhookAccount }
  | { kind: "refused"; reason: "wrong_account" | "lookup_failed" };

/**
 * The account an edge webhook's AccountSid names, for sms-inbound and sms-status (phase 4):
 *   switch off                       → "off", no lookup (`admin` is never touched)
 *   the parent's SID, or no SID      → the parent: the caller keeps its own three-state check
 *   a known ACTIVE sub-account       → that sub: its token is mandatory
 *   anything else / a failed lookup  → refused
 */
export async function requestAccount(
  // deno-lint-ignore no-explicit-any
  admin: any, accountSidParam: unknown, get: EnvGet,
): Promise<RequestAccount> {
  if (!subaccountsOn(get)) return { kind: "off" };
  const sid = String(accountSidParam ?? "").trim();
  const parent = String(get("TWILIO_ACCOUNT_SID") ?? "");
  if (!sid || sid === parent) {
    return {
      kind: "account",
      account: { source: "parent", accountSid: parent || sid, clientId: null, authToken: String(get("TWILIO_AUTH_TOKEN") ?? "") || null },
    };
  }
  try {
    const account = await accountBySid(admin, sid, get);
    return account && account.source === "sub" ? { kind: "account", account } : { kind: "refused", reason: "wrong_account" };
  } catch {
    return { kind: "refused", reason: "lookup_failed" };
  }
}

export type EdgeWebhookVerdict =
  /** The switch is off: the caller runs the check it always ran; nothing was looked up. */
  | { kind: "off" }
  /** The parent's AccountSid (or none): the caller runs its own three-state parent check. */
  | { kind: "parent"; account: WebhookAccount }
  /** A known active sub, and the request IS signed with its token (checked here). */
  | { kind: "sub"; account: WebhookAccount }
  | { kind: "refused"; reason: "wrong_account" | "lookup_failed" | "bad_signature" };

/**
 * The whole account step of an edge Twilio webhook (sms-inbound, sms-status), phase 4: which
 * account the AccountSid names (requestAccount) and, for a sub, its signature with its own token
 * (signedBySub: mandatory, with one revalidation). `check(token)` is the caller's
 * validateTwilioSignature over its own URL. Off: "off", no lookup, `check` never called.
 */
export async function edgeWebhookAccount(
  // deno-lint-ignore no-explicit-any
  admin: any, accountSidParam: unknown, get: EnvGet, check: (token: string) => Promise<boolean>,
): Promise<EdgeWebhookVerdict> {
  const r = await requestAccount(admin, accountSidParam, get);
  if (r.kind !== "account") return r;
  if (r.account.source === "parent") return { kind: "parent", account: r.account };
  const signed = await signedBySub(r.account, (sid, o) => accountBySid(admin, sid, get, Date.now(), o), check);
  return signed ? { kind: "sub", account: signed } : { kind: "refused", reason: "bad_signature" };
}

/** ok, or why an already-authenticated webhook may not touch this tenant. */
export type TenantVerdict = "ok" | "mismatch" | "lookup_failed";

/**
 * May a webhook from `account` touch this tenant (phase 4)? No account (the switch off): "ok" with
 * no lookup. A sub: only its own tenant, answered from its account row (no lookup). The parent:
 * only a tenant with no sub-account (tenantAccountSid, cached); a failed read is "lookup_failed",
 * which the caller treats as a refusal, never as a match.
 */
export async function webhookTenantVerdict(
  // deno-lint-ignore no-explicit-any
  admin: any, account: WebhookAccount | null | undefined, clientId: string, get: EnvGet,
): Promise<TenantVerdict> {
  if (!account || !subaccountsOn(get)) return "ok";
  if (account.source === "sub") return account.clientId !== null && account.clientId === String(clientId ?? "") ? "ok" : "mismatch";
  let tenantSid: string | null;
  try {
    tenantSid = await tenantAccountSid(admin, clientId, get);
  } catch {
    return "lookup_failed";
  }
  return webhookMatchesTenant(account, tenantSid) ? "ok" : "mismatch";
}

/**
 * May an Event Streams event (twilio-events) act on this tenant's registration? Switch off: "ok"
 * with no lookup. On, by the account the tenant lives in:
 *   a sub      → the event must name that sub (`accountsid`);
 *   the parent → the event names the parent, OR NO ACCOUNT AT ALL: an event without the field is
 *                today's event, acted on as before. Whether A2P payloads carry `accountsid` is
 *                unconfirmed (phase 6's spike); the parent's own tenants must not go dark on it.
 * ⚠️ NOT AUTHENTICATION. The payload is written by whoever holds the shared ?key=; this keeps a
 * sub's sink from acting on another account's tenants by mistake, nothing more.
 */
export async function eventAccountVerdict(
  // deno-lint-ignore no-explicit-any
  admin: any, data: unknown, clientId: string, get: EnvGet,
): Promise<TenantVerdict> {
  if (!subaccountsOn(get)) return "ok";
  let tenantSid: string | null;
  try {
    tenantSid = await tenantAccountSid(admin, clientId, get);
  } catch {
    return "lookup_failed";
  }
  const ev = eventAccountSid(data);
  if (tenantSid === null) {
    const parent = String(get("TWILIO_ACCOUNT_SID") ?? "");
    return ev === "" || (parent !== "" && ev === parent) ? "ok" : "mismatch";
  }
  return ev === tenantSid ? "ok" : "mismatch";
}

/**
 * The sub-account SID a tenant's numbers and registration live in, or null for the parent. Switch
 * off: null with no lookup. A sub row counts from the moment it has a SID, whatever its status: a
 * tenant with a sub row holds nothing on the parent (292's twilio_accounts_no_split), so its
 * numbers can only be in the sub, and while that sub is not active its webhooks are refused
 * (accountBySid) rather than taken as the parent's. Throws TwilioAccountError "lookup_failed"
 * (switch on only): the caller refuses.
 */
export async function tenantAccountSid(
  // deno-lint-ignore no-explicit-any
  admin: any, clientId: string, get: EnvGet, now: number = Date.now(),
): Promise<string | null> {
  if (!subaccountsOn(get)) return null;
  const key = String(clientId ?? "");
  const hit = tenantCache.get(key);
  if (hit && hit.until > now) return hit.sid;
  // deno-lint-ignore no-explicit-any
  let res: any;
  try {
    res = await admin.from("twilio_accounts").select("kind, account_sid").eq("client_id", key).maybeSingle();
  } catch (e) {
    throw new TwilioAccountError("lookup_failed", `twilio_accounts did not answer: ${(e as Error)?.message ?? "unknown"}`);
  }
  if (res?.error) throw new TwilioAccountError("lookup_failed", `twilio_accounts read failed (${String(res.error.code ?? "no code")})`);
  const row = (res?.data ?? null) as { kind?: string | null; account_sid?: string | null } | null;
  const sid = row?.kind === "sub" && ACCOUNT_SID.test(String(row.account_sid ?? "")) ? String(row.account_sid) : null;
  remember(tenantCache, key, { until: now + (sid ? TENANT_TTL_MS : MISS_TTL_MS), sid });
  return sid;
}

/** The AccountSid an Event Streams event's payload carries (`accountsid`, lowercase like its other
 *  fields; the camel and Pascal spellings are accepted the way twilio-events reads brandsid), or "". */
export function eventAccountSid(data: unknown): string {
  const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const v = String(d.accountsid ?? d.accountSid ?? d.AccountSid ?? "").trim();
  return ACCOUNT_SID.test(v) ? v : "";
}

/** Is this webhook's account the tenant's? `tenantSid` is tenantAccountSid's answer (null = the
 *  parent). A sub's webhook may only ever touch its own tenant; the parent's only tenants on the
 *  parent. */
export function webhookMatchesTenant(account: WebhookAccount, tenantSid: string | null): boolean {
  return tenantSid === null ? account.source === "parent" : account.source === "sub" && account.accountSid === tenantSid;
}
