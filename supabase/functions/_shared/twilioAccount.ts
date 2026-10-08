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
 * setup-test app and NTS. A tenant with no row is on the parent, so none of them needs one.
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

/** Per isolate. A known active sub is kept 5 minutes (its row and token do not change under a
 *  running request); an unknown SID only 30 seconds, so a sub made active a moment ago is
 *  recognised promptly. Failures are never kept. */
const SUB_TTL_MS = 5 * 60_000;
const MISS_TTL_MS = 30_000;
const bySidCache = new Map<string, { until: number; account: WebhookAccount | null }>();
const tenantCache = new Map<string, { until: number; sid: string | null }>();

/** Tests only: forget every cached answer. */
export function _resetTwilioAccountCaches(): void {
  bySidCache.clear();
  tenantCache.clear();
}

/**
 * The account a webhook's AccountSid names, if it is one of ours:
 *   the parent (TWILIO_ACCOUNT_SID)      → the parent, from the environment, no lookup
 *   switch off                           → null, no lookup (callers keep today's check)
 *   an ACTIVE sub with its auth token    → that sub
 *   anything else                        → null (the caller answers wrong_account)
 * Throws TwilioAccountError "lookup_failed" when the lookup fails: the caller refuses the request.
 */
export async function accountBySid(
  // deno-lint-ignore no-explicit-any
  admin: any, sid: string, get: EnvGet, now: number = Date.now(),
): Promise<WebhookAccount | null> {
  const s = String(sid ?? "").trim();
  if (!ACCOUNT_SID.test(s)) return null;
  const parent = String(get("TWILIO_ACCOUNT_SID") ?? "");
  if (parent && s === parent) {
    return { source: "parent", accountSid: s, clientId: null, authToken: String(get("TWILIO_AUTH_TOKEN") ?? "") || null };
  }
  if (!subaccountsOn(get)) return null;
  const hit = bySidCache.get(s);
  if (hit && hit.until > now) return hit.account;
  const row = await credsRow(admin, { p_account_sid: s });
  const token = String(row?.auth_token ?? "");
  const account: WebhookAccount | null = row && row.kind === "sub" && row.status === "active" && token
      && String(row.account_sid ?? "") === s
    ? { source: "sub", accountSid: s, clientId: row.client_id ? String(row.client_id) : null, authToken: token }
    : null;
  bySidCache.set(s, { until: now + (account ? SUB_TTL_MS : MISS_TTL_MS), account });
  return account;
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

/**
 * The sub-account SID a tenant's numbers and registration live in, or null for the parent. Switch
 * off: null with no lookup. A sub row counts from the moment it has a SID (it has no numbers
 * before then). Throws TwilioAccountError "lookup_failed" (switch on only): the caller refuses.
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
  tenantCache.set(key, { until: now + (sid ? SUB_TTL_MS : MISS_TTL_MS), sid });
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
