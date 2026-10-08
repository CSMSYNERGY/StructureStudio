/**
 * Making a builder's own Twilio sub-account, and everything Twilio needs inside it (Workstream 2,
 * phase 3), plus what the operator console does to one (phase 9: look, suspend, reactivate, close).
 *
 * IMPORTERS (deploy every one when this file changes; re-run the importer grep at deploy time):
 *   portal-settings/index.ts   phone_buy_number: ensureTwilioAccount before the wallet hold
 *   portal-sms/index.ts        advance (first submit) and buy_number: ensureTwilioAccount
 *   admin-catalog/index.ts     twilio_account_get / _provision / _suspend / _close, delete_client
 * Leaf-ish: its one import is _shared/twilioAccount.ts (zero imports itself). Every Twilio request
 * goes through an injectable `http`, so the tests drive every step offline.
 *
 * ── WHEN IT RUNS ─────────────────────────────────────────────────────────────────────────
 * ensureTwilioAccount is a no-op while TWILIO_SUBACCOUNTS is not exactly "on": its first line
 * answers "the parent" and nothing is read or written. One Supabase project serves beta and
 * production, so switch-off has to be exactly today. The one exception is the operator console's
 * Create button (`operator: true`), which runs whatever the switch says so the first TEST sub can
 * be made before the switch goes on; the console makes the operator type the builder's id first.
 *
 * WHO STAYS ON THE PARENT (no sub is ever made for them): a tenant with a kind 'parent' row (292's
 * pins), our own internal account (client_settings.internal_account), and any tenant that already
 * holds something on the parent (292's twilio_parent_holdings: a live number, a registration that
 * reached Twilio, a texting number). The last two get a parent pin row written here, so the next
 * call answers from the row. 292's trigger twilio_accounts_no_split refuses a sub row for such a
 * tenant anyway: one tenant, one account.
 *
 * ── THE STEPS, IN ORDER, EACH SID WRITTEN THE MOMENT IT EXISTS ───────────────────────────
 *   account     the sub-account itself, FriendlyName = the client_id (NEVER a business name: the
 *               repository is public and so is a Twilio console screenshot). Made with the PARENT's
 *               Account SID + AUTH TOKEN: parent API keys cannot create sub-accounts or reach their
 *               resources, so with only a key configured this refuses (not_configured).
 *   auth_token  the sub's auth token (it comes back on create; a lost response is re-read from the
 *               account with the parent's token) into Vault: twilio_account_secret_put (292).
 *   api_key     a Standard API key minted INSIDE the sub (iam.twilio.com/v1/Keys) with the sub's
 *               own SID + auth token; its secret into Vault. A key whose secret we never stored is
 *               useless (Twilio shows a secret once), so one recorded without its secret, or found
 *               by name after a lost response, is deleted and a fresh one made.
 *   twiml_app   the calls TwiML App, in the sub: voice URL <BASE>/voice/outbound?key=, status
 *               callback <BASE>/voice/status?leg=client&key= (the status URL MUST carry the key:
 *               the Worker refuses one without it, SETUP.md step 2.3), fallback the parent's.
 *   push        the push credentials (APNs development bundle, APNs store bundle, FCM), each from
 *               twilio_push_material() (migration 295). Material that is not in Vault is SKIPPED and
 *               recorded (push_skipped): the sub still works for the extension and for calling out,
 *               and /token already answers incoming_push:false without one.
 *   events      an Event Streams webhook sink to twilio-events?key= and a subscription to the A2P
 *               event types (A2P_EVENT_TYPES, or TWILIO_EVENT_TYPES to copy the parent's list).
 *   verify      the sub's voice dialing-permissions setting must say it INHERITS the parent's (US and
 *               Canada only, premium blocked: SETUP.md step 2.5), and the stored auth token must be
 *               accepted by Twilio (a wrong token silently 401s every webhook the sub sends). Then
 *               status 'active', provision_step 'done'.
 * Before every create, the object is LOOKED UP by its name first, so a response lost in flight (the
 * object made, the SID never written) is adopted, never made twice. A Vault write that fails stops
 * the run there, before the next create.
 *
 * ── THE LOCK ─────────────────────────────────────────────────────────────────────────────
 * provision_lock_until, taken in ONE conditional update (portal-sms advance_lock_until's pattern),
 * every write guarded by it, released in a finally. A second caller while it is held gets "busy"
 * (409). A run that fails records provision_step and last_error (codes only) and status 'failed';
 * the next call resumes from where it stopped.
 *
 * ⚠️ NOTHING HERE IS LOGGED OR RETURNED WITH A SECRET OR A TWILIO MESSAGE BODY: codes only.
 */

import { subaccountsOn, type EnvGet } from "./twilioAccount.ts";

const API = "https://api.twilio.com/2010-04-01";
const IAM = "https://iam.twilio.com/v1";
const CHAT = "https://chat.twilio.com/v2";
const EVENTS = "https://events.twilio.com/v1";
const VOICE = "https://voice.twilio.com/v1";

/** The Worker's public base when PHONE_API_BASE is not set. ⚠️ The same value as
 *  portal-settings/phoneNumber.ts DEFAULT_PHONE_API_BASE (tests/phone/twilioProvisionWiring_test.ts
 *  pins the two equal): _shared cannot import from a function's own folder. */
export const DEFAULT_PHONE_API_BASE = "https://phone.structurestudiosuite.com";

/**
 * The Event Streams types a sub's subscription asks for: the A2P brand, campaign and
 * number-registration events twilio-events acts on (brand and campaign by their payload fields,
 * numbers by these three types). Twilio's A2P list ("event-streams-setup") also has three
 * number-DEregistration types; twilio-events does nothing with them, so they are not asked for.
 * TWILIO_EVENT_TYPES (comma-separated) replaces this list, to copy the parent's exactly from the
 * phase 0 inventory.
 */
export const A2P_EVENT_TYPES: readonly string[] = [
  "com.twilio.messaging.compliance.brand-registration.brand-registered",
  "com.twilio.messaging.compliance.brand-registration.brand-failure",
  "com.twilio.messaging.compliance.brand-registration.brand-verified",
  "com.twilio.messaging.compliance.brand-registration.brand-unverified",
  "com.twilio.messaging.compliance.brand-registration.brand-vetted-verified",
  "com.twilio.messaging.compliance.brand-registration.brand-secondary-vetting-failure",
  "com.twilio.messaging.compliance.campaign-registration.campaign-submitted",
  "com.twilio.messaging.compliance.campaign-registration.campaign-failure",
  "com.twilio.messaging.compliance.campaign-registration.campaign-approved",
  "com.twilio.messaging.compliance.number-registration.pending",
  "com.twilio.messaging.compliance.number-registration.successful",
  "com.twilio.messaging.compliance.number-registration.failed",
];

export const PROVISION_STEPS = ["account", "auth_token", "api_key", "twiml_app", "push", "events", "verify"] as const;
export type ProvisionStep = typeof PROVISION_STEPS[number];

export const PUSH_KINDS = ["apns_dev", "apns_prod", "fcm"] as const;
export type PushKind = typeof PUSH_KINDS[number];
const PUSH_COLUMN: Record<PushKind, "push_apns_dev_sid" | "push_apns_prod_sid" | "push_fcm_sid"> = {
  apns_dev: "push_apns_dev_sid", apns_prod: "push_apns_prod_sid", fcm: "push_fcm_sid",
};

/** How long one run may hold the lock. A run makes at most ~20 requests. */
export const PROVISION_LOCK_MS = 5 * 60_000;

// ── Transport ─────────────────────────────────────────────────────────────────────────────

export type BasicAuth = { user: string; pass: string };
/** One Twilio request. Resolves with the status and the parsed body (non-2xx included); REJECTS
 *  only when there was no answer at all (the request may or may not have happened). */
export type ProvisionHttp = (
  method: "GET" | "POST" | "DELETE",
  url: string,
  auth: BasicAuth,
  form?: Array<[string, string]>,
) => Promise<{ status: number; body: any }>;

export const fetchHttp: ProvisionHttp = async (method, url, auth, form) => {
  const res = await fetch(url, {
    method,
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${btoa(`${auth.user}:${auth.pass}`)}`,
      ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  const text = await res.text();
  let body: any = {};
  try { body = text ? JSON.parse(text) : {}; } catch { /* a non-JSON error page */ }
  return { status: res.status, body };
};

/** A step that did not finish. `code` is ours or Twilio's numeric code, never a message. */
export class ProvisionError extends Error {
  readonly step: ProvisionStep | "lock" | "config";
  readonly code: string;
  /** The status the caller answers with. */
  readonly httpStatus: number;
  constructor(step: ProvisionStep | "lock" | "config", code: string, httpStatus = 502) {
    super(`twilio provisioning stopped at ${step} (${code})`);
    this.name = "ProvisionError";
    this.step = step;
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

async function tw(
  http: ProvisionHttp, step: ProvisionStep, method: "GET" | "POST" | "DELETE", url: string, auth: BasicAuth,
  form?: Array<[string, string]>, okStatuses: number[] = [],
): Promise<any> {
  let r: { status: number; body: any };
  try {
    r = await http(method, url, auth, form);
  } catch {
    throw new ProvisionError(step, "unreachable");
  }
  if ((r.status >= 200 && r.status < 300) || okStatuses.includes(r.status)) return r.body ?? {};
  const code = typeof r.body?.code === "number" ? String(r.body.code) : `http_${r.status}`;
  throw new ProvisionError(step, code);
}

// ── Configuration ─────────────────────────────────────────────────────────────────────────

export type ProvisionConfig = {
  parentSid: string;
  parentToken: string;
  voiceUrl: string;
  statusUrl: string;
  fallbackUrl: string;
  sinkUrl: string;
  eventTypes: string[];
};

const ACCOUNT_SID = /^AC[0-9a-f]{32}$/i;
const EVENT_TYPE = /^com\.twilio\.[a-z0-9.-]+$/;
const HTTPS = /^https:\/\/[^/?#\s]+(\/[^?#\s]*)?$/;

/**
 * Everything provisioning needs from the edge environment, or the NAMES of what is missing (never a
 * value). `parentKeyOnly` marks the one case worth its own sentence: the parent has API keys but no
 * auth token, and parent keys can neither create a sub-account nor reach one.
 */
export function provisionConfig(get: EnvGet):
  { ok: true; config: ProvisionConfig } | { ok: false; missing: string[]; parentKeyOnly: boolean } {
  const missing: string[] = [];
  const parentSid = String(get("TWILIO_ACCOUNT_SID") ?? "").trim();
  const parentToken = String(get("TWILIO_AUTH_TOKEN") ?? "").trim();
  if (!ACCOUNT_SID.test(parentSid)) missing.push("TWILIO_ACCOUNT_SID");
  if (!parentToken) missing.push("TWILIO_AUTH_TOKEN");
  const parentKeyOnly = !parentToken && !!String(get("TWILIO_API_KEY") ?? "").trim();
  const base = String(get("PHONE_API_BASE") ?? "").trim().replace(/\/+$/, "") || DEFAULT_PHONE_API_BASE;
  if (!HTTPS.test(base)) missing.push("PHONE_API_BASE");
  const key = String(get("PHONE_WEBHOOK_SECRET") ?? "").trim();
  if (!key) missing.push("PHONE_WEBHOOK_SECRET");
  // The calls app's fallback: its own Bin when one is set (SETUP.md 2.3's "Calling is having a
  // problem" Bin), else the parent's number fallback the edge already knows.
  const fallbackUrl = [get("TWILIO_APP_FALLBACK_URL"), get("PHONE_FALLBACK_URL")]
    .map((v) => String(v ?? "").trim()).find((v) => /^https:\/\/\S+$/.test(v)) ?? "";
  if (!fallbackUrl) missing.push("PHONE_FALLBACK_URL");
  const supabase = String(get("SUPABASE_URL") ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\/\S+$/.test(supabase)) missing.push("SUPABASE_URL");
  const eventsKey = String(get("TWILIO_EVENTS_SECRET") ?? "").trim();
  if (!eventsKey) missing.push("TWILIO_EVENTS_SECRET");
  const typesRaw = String(get("TWILIO_EVENT_TYPES") ?? "").trim();
  const eventTypes = typesRaw ? typesRaw.split(",").map((t) => t.trim()).filter(Boolean) : [...A2P_EVENT_TYPES];
  if (!eventTypes.length || eventTypes.some((t) => !EVENT_TYPE.test(t))) missing.push("TWILIO_EVENT_TYPES");
  if (missing.length) return { ok: false, missing, parentKeyOnly };
  const k = encodeURIComponent(key);
  return {
    ok: true,
    config: {
      parentSid, parentToken,
      voiceUrl: `${base}/voice/outbound?key=${k}`,
      statusUrl: `${base}/voice/status?leg=client&key=${k}`,
      fallbackUrl,
      sinkUrl: `${supabase}/functions/v1/twilio-events?key=${encodeURIComponent(eventsKey)}`,
      eventTypes,
    },
  };
}

// ── The row ───────────────────────────────────────────────────────────────────────────────

export type AccountRow = {
  client_id: string;
  kind: "parent" | "sub";
  account_sid: string | null;
  status: "provisioning" | "active" | "suspended" | "closed" | "failed";
  api_key_sid: string | null;
  api_secret_id: string | null;
  auth_token_id: string | null;
  twiml_app_sid: string | null;
  push_apns_dev_sid: string | null;
  push_apns_prod_sid: string | null;
  push_fcm_sid: string | null;
  events_sink_sid: string | null;
  events_subscription_sid: string | null;
  provision_step: string | null;
  provision_lock_until: string | null;
  last_error: string | null;
  push_skipped: string[] | null;
  created_at?: string | null;
  updated_at?: string | null;
};

/** 292's columns plus 295's push_skipped. */
export const ROW_COLUMNS = "client_id, kind, account_sid, status, api_key_sid, api_secret_id, auth_token_id, twiml_app_sid, "
  + "push_apns_dev_sid, push_apns_prod_sid, push_fcm_sid, events_sink_sid, events_subscription_sid, provision_step, "
  + "provision_lock_until, last_error, push_skipped, created_at, updated_at";
/** What the fast path (an active sub, or a pin) needs: 292's columns only. */
const FAST_COLUMNS = "client_id, kind, account_sid, status, provision_step";

// deno-lint-ignore no-explicit-any
type Admin = any;

type Pg = { code?: string; message?: string } | null | undefined;
const pgCode = (e: Pg) => String(e?.code ?? "no_code");

/** Why a tenant stays on the parent, or null: a pin, our own internal account, or something it
 *  already holds there. Throws ProvisionError("config", "lookup_failed") when that cannot be told. */
async function parentReason(admin: Admin, clientId: string): Promise<"internal" | "parent_holdings" | null> {
  const cs = await admin.from("client_settings").select("internal_account").eq("client_id", clientId).maybeSingle();
  if (cs?.error) throw new ProvisionError("config", `lookup_failed_${pgCode(cs.error)}`, 502);
  if (cs?.data?.internal_account === true) return "internal";
  const h = await admin.rpc("twilio_parent_holdings", { p_client_id: clientId });
  if (h?.error) throw new ProvisionError("config", `lookup_failed_${pgCode(h.error)}`, 502);
  return h?.data ? "parent_holdings" : null;
}

// ── ensureTwilioAccount ───────────────────────────────────────────────────────────────────

export type EnsureResult =
  | { ok: true; kind: "parent"; reason: "switch_off" | "pinned" | "internal" | "parent_holdings" }
  | { ok: true; kind: "sub"; accountSid: string; ran: boolean; pushSkipped: string[] }
  | {
    ok: false;
    reason: "not_configured" | "busy" | "lookup_failed" | "failed" | "suspended" | "closed";
    /** The status the caller answers with: 503 not configured, 409 busy, 403 suspended/closed, 502 the rest. */
    status: number;
    step: string | null;
    code: string;
    /** not_configured: the environment names that are missing (never their values). */
    missing?: string[];
    parentKeyOnly?: boolean;
  };

export type EnsureOpts = {
  get: EnvGet;
  http?: ProvisionHttp;
  now?: () => number;
  /** The operator console's Create: runs while TWILIO_SUBACCOUNTS is off, and on an active sub
   *  that skipped push credentials it runs again to fill them in. */
  operator?: boolean;
  lockMs?: number;
};

/** The builder-facing sentence for a refusal (the console says more). */
export function ensureRefusalSentence(r: Extract<EnsureResult, { ok: false }>): string {
  switch (r.reason) {
    case "busy": return "Your phone account is being set up right now. Try again in a minute.";
    case "suspended":
    case "closed": return "Your phone account is paused. Contact Structure Studio.";
    case "not_configured": return "Phone numbers aren't available on this server yet.";
    default: return "Couldn't set up your phone account just now. Try again in a few minutes.";
  }
}

/**
 * Make sure this tenant's Twilio account exists and is ready, idempotently and resumably (see the
 * header). Answers which account the tenant is on; `ok: false` means nothing should be bought or
 * registered for it now.
 */
export async function ensureTwilioAccount(admin: Admin, clientId: string, opts: EnsureOpts): Promise<EnsureResult> {
  // ⚠️ OFF MEANS NOTHING: no read, no write, no Twilio. The console's Create is the one exception.
  if (!opts.operator && !subaccountsOn(opts.get)) return { ok: true, kind: "parent", reason: "switch_off" };
  const now = opts.now ?? Date.now;
  const http = opts.http ?? fetchHttp;
  const fail = (reason: Extract<EnsureResult, { ok: false }>["reason"], status: number, step: string | null, code: string,
    extra: Partial<Extract<EnsureResult, { ok: false }>> = {}): EnsureResult => ({ ok: false, reason, status, step, code, ...extra });

  const read = await admin.from("twilio_accounts").select(FAST_COLUMNS).eq("client_id", clientId).maybeSingle();
  if (read?.error) return fail("lookup_failed", 502, null, `lookup_failed_${pgCode(read.error)}`);
  const fast = (read?.data ?? null) as Pick<AccountRow, "kind" | "account_sid" | "status" | "provision_step"> | null;

  if (fast?.kind === "parent") return { ok: true, kind: "parent", reason: "pinned" };
  if (fast?.kind === "sub") {
    if (fast.status === "suspended") return fail("suspended", 403, null, "suspended");
    if (fast.status === "closed") return fail("closed", 403, null, "closed");
    if (fast.status === "active" && fast.provision_step === "done" && !opts.operator) {
      return { ok: true, kind: "sub", accountSid: String(fast.account_sid), ran: false, pushSkipped: [] };
    }
  }

  if (!fast) {
    let why: "internal" | "parent_holdings" | null;
    try {
      why = await parentReason(admin, clientId);
    } catch (e) {
      return fail("lookup_failed", 502, null, (e as ProvisionError).code ?? "lookup_failed");
    }
    if (why) {
      // The pin is a record: the next call answers from the row. A failed write changes nothing
      // (the same reason is found again next time), so it is not an error.
      await admin.from("twilio_accounts").upsert({ client_id: clientId, kind: "parent", status: "active" },
        { onConflict: "client_id", ignoreDuplicates: true }).then(() => {}, () => {});
      return { ok: true, kind: "parent", reason: why };
    }
  }

  const cfg = provisionConfig(opts.get);
  if (!cfg.ok) {
    return fail("not_configured", 503, "config", cfg.parentKeyOnly ? "parent_token_missing" : "env_missing",
      { missing: cfg.missing, parentKeyOnly: cfg.parentKeyOnly });
  }

  if (!fast) {
    const made = await admin.from("twilio_accounts").upsert(
      { client_id: clientId, kind: "sub", status: "provisioning", provision_step: "account" },
      { onConflict: "client_id", ignoreDuplicates: true },
    );
    if (made?.error) {
      // 23514: 292's guard (twilio_accounts_no_split) found something on the parent after all.
      if (pgCode(made.error) === "23514") return { ok: true, kind: "parent", reason: "parent_holdings" };
      return fail("lookup_failed", 502, null, `insert_failed_${pgCode(made.error)}`);
    }
  }

  // ── The lock: one conditional update, a row back or nothing ──
  const nowIso = new Date(now()).toISOString();
  const lockUntil = new Date(now() + (opts.lockMs ?? PROVISION_LOCK_MS)).toISOString();
  const locked = await admin.from("twilio_accounts")
    .update({ provision_lock_until: lockUntil, updated_at: nowIso })
    .eq("client_id", clientId).eq("kind", "sub")
    .or(`provision_lock_until.is.null,provision_lock_until.lt.${nowIso}`)
    .select(ROW_COLUMNS).maybeSingle();
  if (locked?.error) return fail("lookup_failed", 502, "lock", `lock_failed_${pgCode(locked.error)}`);
  if (!locked?.data) return fail("busy", 409, "lock", "busy");

  const row = locked.data as AccountRow;
  // Another run finished, or the row changed, between the read and the lock.
  if (row.kind !== "sub") {
    await releaseLock(admin, clientId, lockUntil);
    return { ok: true, kind: "parent", reason: "pinned" };
  }
  if (row.status === "suspended" || row.status === "closed") {
    await releaseLock(admin, clientId, lockUntil);
    return fail(row.status, 403, null, row.status);
  }
  const refill = !!opts.operator && row.status === "active" && row.provision_step === "done";
  if (row.status === "active" && row.provision_step === "done" && !(refill && (row.push_skipped ?? []).length)) {
    await releaseLock(admin, clientId, lockUntil);
    return { ok: true, kind: "sub", accountSid: String(row.account_sid), ran: false, pushSkipped: row.push_skipped ?? [] };
  }

  const run = new Run(admin, clientId, row, lockUntil, cfg.config, http, now);
  try {
    await run.all();
    return { ok: true, kind: "sub", accountSid: String(run.row.account_sid), ran: true, pushSkipped: run.row.push_skipped ?? [] };
  } catch (e) {
    const pe = e instanceof ProvisionError ? e : new ProvisionError(run.step, "error");
    await run.recordFailure(pe).catch(() => {});
    return fail(pe.code === "lock_lost" ? "busy" : "failed", pe.code === "lock_lost" ? 409 : pe.httpStatus, pe.step, pe.code);
  } finally {
    await releaseLock(admin, clientId, lockUntil).catch(() => {});
  }
}

async function releaseLock(admin: Admin, clientId: string, lockUntil: string): Promise<void> {
  await admin.from("twilio_accounts").update({ provision_lock_until: null })
    .eq("client_id", clientId).eq("provision_lock_until", lockUntil);
}

/** One provisioning run, holding the lock. */
class Run {
  step: ProvisionStep = "account";
  /** The sub's auth token when this run has it in hand (from the create), so a Vault write that
   *  fails can be retried by the next run with a fresh read instead. */
  private tokenInHand: string | null = null;

  constructor(
    readonly admin: Admin,
    readonly clientId: string,
    public row: AccountRow,
    readonly lockUntil: string,
    readonly cfg: ProvisionConfig,
    readonly http: ProvisionHttp,
    readonly now: () => number,
  ) {}

  private get parentAuth(): BasicAuth {
    return { user: this.cfg.parentSid, pass: this.cfg.parentToken };
  }

  /** Write to the row, only while this run still holds the lock. */
  private async write(patch: Partial<AccountRow>): Promise<void> {
    const res = await this.admin.from("twilio_accounts")
      .update({ ...patch, updated_at: new Date(this.now()).toISOString() })
      .eq("client_id", this.clientId).eq("provision_lock_until", this.lockUntil).select("client_id");
    if (res?.error) throw new ProvisionError(this.step, `db_write_${pgCode(res.error)}`);
    if (!Array.isArray(res?.data) || !res.data.length) throw new ProvisionError(this.step, "lock_lost", 409);
    this.row = { ...this.row, ...patch };
  }

  /** The sub's secrets as Vault holds them (twilio_account_creds, 292). */
  private async creds(): Promise<{ auth_token: string | null; api_secret: string | null }> {
    const res = await this.admin.rpc("twilio_account_creds", { p_client_id: this.clientId });
    if (res?.error) throw new ProvisionError(this.step, "vault");
    const rows = Array.isArray(res?.data) ? res.data : res?.data ? [res.data] : [];
    const r = rows[0] ?? {};
    return { auth_token: r.auth_token ? String(r.auth_token) : null, api_secret: r.api_secret ? String(r.api_secret) : null };
  }

  private async putSecret(kind: "auth_token" | "api_secret", secret: string): Promise<void> {
    const res = await this.admin.rpc("twilio_account_secret_put", { p_client_id: this.clientId, p_kind: kind, p_secret: secret });
    // ⚠️ STOP HERE: the next step would create something Twilio bills or that needs this secret.
    if (res?.error) throw new ProvisionError(this.step, "vault");
  }

  async recordFailure(pe: ProvisionError): Promise<void> {
    const keepActive = this.row.status === "active";
    await this.admin.from("twilio_accounts").update({
      status: keepActive ? "active" : "failed",
      provision_step: (PROVISION_STEPS as readonly string[]).includes(pe.step) ? pe.step : this.row.provision_step,
      last_error: `${pe.step}:${pe.code}`.slice(0, 200),
      updated_at: new Date(this.now()).toISOString(),
    }).eq("client_id", this.clientId).eq("provision_lock_until", this.lockUntil);
  }

  async all(): Promise<void> {
    await this.account();
    const subAuth = await this.authToken();
    const keyAuth = await this.apiKey(subAuth);
    await this.twimlApp(keyAuth);
    await this.push(keyAuth);
    await this.events(keyAuth);
    await this.verify(keyAuth);
  }

  // ── 1. The sub-account ──
  private async account(): Promise<void> {
    this.step = "account";
    if (this.row.account_sid) return;
    // Looked up first: a create whose response was lost left an account with our name.
    const list = await tw(this.http, "account", "GET",
      `${API}/Accounts.json?${new URLSearchParams({ FriendlyName: this.clientId, PageSize: "50" })}`, this.parentAuth);
    // deno-lint-ignore no-explicit-any
    const ours = (Array.isArray(list?.accounts) ? list.accounts : []).filter((a: any) =>
      String(a?.friendly_name ?? "") === this.clientId && ACCOUNT_SID.test(String(a?.sid ?? ""))
      && String(a.sid) !== this.cfg.parentSid && String(a?.status ?? "") !== "closed");
    if (ours.length > 1) throw new ProvisionError("account", "duplicate_subaccounts", 409);
    let sid: string;
    if (ours.length === 1) {
      if (String(ours[0].status ?? "") === "suspended") throw new ProvisionError("account", "found_suspended", 409);
      sid = String(ours[0].sid);
      this.tokenInHand = ours[0].auth_token ? String(ours[0].auth_token) : null;
    } else {
      const made = await tw(this.http, "account", "POST", `${API}/Accounts.json`, this.parentAuth, [["FriendlyName", this.clientId]]);
      sid = String(made?.sid ?? "");
      if (!ACCOUNT_SID.test(sid)) throw new ProvisionError("account", "no_sid");
      this.tokenInHand = made?.auth_token ? String(made.auth_token) : null;
    }
    await this.write({ account_sid: sid, provision_step: "auth_token" });
  }

  // ── 2. Its auth token, into Vault ──
  private async authToken(): Promise<BasicAuth> {
    this.step = "auth_token";
    const sid = String(this.row.account_sid);
    let token = (await this.creds()).auth_token;
    if (!token) {
      token = this.tokenInHand;
      if (!token) {
        // The parent's token reads a sub's (Twilio returns auth_token on a sub-account fetch).
        const acct = await tw(this.http, "auth_token", "GET", `${API}/Accounts/${sid}.json`, this.parentAuth);
        token = acct?.auth_token ? String(acct.auth_token) : null;
      }
      if (!token) throw new ProvisionError("auth_token", "token_unreadable");
      await this.putSecret("auth_token", token);
      await this.write({ provision_step: "api_key" });
    }
    this.tokenInHand = null;
    return { user: sid, pass: token };
  }

  // ── 3. A Standard API key inside the sub, its secret into Vault ──
  private async apiKey(subAuth: BasicAuth): Promise<BasicAuth> {
    this.step = "api_key";
    const sid = String(this.row.account_sid);
    const secret = (await this.creds()).api_secret;
    if (this.row.api_key_sid && secret) return { user: this.row.api_key_sid, pass: secret };
    // A key recorded without its secret, or one with our name the row never saw (a lost response):
    // Twilio never shows a secret again, so they are useless. Deleted, then one is made fresh.
    const list = await tw(this.http, "api_key", "GET", `${IAM}/Keys?${new URLSearchParams({ AccountSid: sid, PageSize: "100" })}`, subAuth);
    // deno-lint-ignore no-explicit-any
    const stale = (Array.isArray(list?.keys) ? list.keys : []).filter((k: any) =>
      /^SK[0-9a-f]{32}$/i.test(String(k?.sid ?? "")) && (String(k?.friendly_name ?? "") === this.clientId || String(k.sid) === this.row.api_key_sid));
    for (const k of stale) await tw(this.http, "api_key", "DELETE", `${IAM}/Keys/${k.sid}`, subAuth, undefined, [404]);
    const made = await tw(this.http, "api_key", "POST", `${IAM}/Keys`, subAuth, [["AccountSid", sid], ["FriendlyName", this.clientId]]);
    const keySid = String(made?.sid ?? "");
    const keySecret = String(made?.secret ?? "");
    if (!/^SK[0-9a-f]{32}$/i.test(keySid) || !keySecret) throw new ProvisionError("api_key", "no_sid");
    await this.write({ api_key_sid: keySid });
    await this.putSecret("api_secret", keySecret);
    await this.write({ provision_step: "twiml_app" });
    return { user: keySid, pass: keySecret };
  }

  // ── 4. The calls TwiML App ──
  private async twimlApp(auth: BasicAuth): Promise<void> {
    this.step = "twiml_app";
    if (this.row.twiml_app_sid) return;
    const sid = String(this.row.account_sid);
    const config: Array<[string, string]> = [
      ["VoiceUrl", this.cfg.voiceUrl], ["VoiceMethod", "POST"],
      // ⚠️ The status URL carries ?key= like every Worker URL (SETUP.md 2.3): without it, bad_key.
      ["StatusCallback", this.cfg.statusUrl], ["StatusCallbackMethod", "POST"],
      ["VoiceFallbackUrl", this.cfg.fallbackUrl], ["VoiceFallbackMethod", "POST"],
    ];
    const list = await tw(this.http, "twiml_app", "GET",
      `${API}/Accounts/${sid}/Applications.json?${new URLSearchParams({ FriendlyName: this.clientId, PageSize: "20" })}`, auth);
    // deno-lint-ignore no-explicit-any
    const found = (Array.isArray(list?.applications) ? list.applications : []).find((a: any) =>
      String(a?.friendly_name ?? "") === this.clientId && /^AP[0-9a-f]{32}$/i.test(String(a?.sid ?? "")));
    let appSid: string;
    if (found) {
      appSid = String(found.sid);
      // Adopted: its URLs are set again, so a half-made app cannot keep wrong ones.
      await tw(this.http, "twiml_app", "POST", `${API}/Accounts/${sid}/Applications/${appSid}.json`, auth, config);
    } else {
      const made = await tw(this.http, "twiml_app", "POST", `${API}/Accounts/${sid}/Applications.json`, auth,
        [["FriendlyName", this.clientId], ...config]);
      appSid = String(made?.sid ?? "");
      if (!/^AP[0-9a-f]{32}$/i.test(appSid)) throw new ProvisionError("twiml_app", "no_sid");
    }
    await this.write({ twiml_app_sid: appSid, provision_step: "push" });
  }

  // ── 5. The push credentials ──
  private async push(auth: BasicAuth): Promise<void> {
    this.step = "push";
    const todo = PUSH_KINDS.filter((k) => !this.row[PUSH_COLUMN[k]]);
    if (!todo.length) {
      if (this.row.push_skipped?.length) await this.write({ push_skipped: null });
      return;
    }
    const mat = await this.admin.rpc("twilio_push_material", {});
    if (mat?.error) throw new ProvisionError("push", "vault");
    // deno-lint-ignore no-explicit-any
    const byKind = new Map<string, any>((Array.isArray(mat?.data) ? mat.data : []).map((m: any) => [String(m?.kind ?? ""), m]));
    const skipped: PushKind[] = [];
    // deno-lint-ignore no-explicit-any
    let existing: any[] | null = null;
    for (const kind of todo) {
      const m = byKind.get(kind) ?? {};
      const apn = kind !== "fcm";
      const complete = apn ? !!(m.certificate && m.private_key) : !!m.secret;
      if (!complete) { skipped.push(kind); continue; }
      const name = pushName(this.clientId, kind);
      if (!existing) {
        const list = await tw(this.http, "push", "GET", `${CHAT}/Credentials?PageSize=100`, auth);
        existing = Array.isArray(list?.credentials) ? list.credentials : [];
      }
      const found = (existing ?? []).find((c) => String(c?.friendly_name ?? "") === name && /^CR[0-9a-f]{32}$/i.test(String(c?.sid ?? "")));
      let credSid: string;
      if (found) {
        credSid = String(found.sid);
      } else {
        const form: Array<[string, string]> = apn
          // Sandbox UNTICKED for both (the Worker's DEVIATIONS "One APNs environment").
          ? [["Type", "apn"], ["FriendlyName", name], ["Certificate", String(m.certificate)], ["PrivateKey", String(m.private_key)], ["Sandbox", "false"]]
          : [["Type", "fcm"], ["FriendlyName", name], ["Secret", String(m.secret)]];
        const made = await tw(this.http, "push", "POST", `${CHAT}/Credentials`, auth, form);
        credSid = String(made?.sid ?? "");
        if (!/^CR[0-9a-f]{32}$/i.test(credSid)) throw new ProvisionError("push", "no_sid");
      }
      await this.write({ [PUSH_COLUMN[kind]]: credSid } as Partial<AccountRow>);
    }
    await this.write({ push_skipped: skipped.length ? skipped : null, provision_step: "events" });
  }

  // ── 6. Event Streams: the sink and its subscription ──
  private async events(auth: BasicAuth): Promise<void> {
    this.step = "events";
    if (!this.row.events_sink_sid) {
      const list = await tw(this.http, "events", "GET", `${EVENTS}/Sinks?PageSize=50`, auth);
      // deno-lint-ignore no-explicit-any
      const found = (Array.isArray(list?.sinks) ? list.sinks : []).find((s: any) =>
        String(s?.description ?? "") === this.clientId && /^DG[0-9a-f]{32}$/i.test(String(s?.sid ?? "")));
      let sinkSid: string;
      let fresh = false;
      if (found) {
        sinkSid = String(found.sid);
      } else {
        const made = await tw(this.http, "events", "POST", `${EVENTS}/Sinks`, auth, [
          ["Description", this.clientId], ["SinkType", "webhook"],
          ["SinkConfiguration", JSON.stringify({ destination: this.cfg.sinkUrl, method: "POST", batch_events: false })],
        ]);
        sinkSid = String(made?.sid ?? "");
        if (!/^DG[0-9a-f]{32}$/i.test(sinkSid)) throw new ProvisionError("events", "no_sid");
        fresh = true;
      }
      await this.write({ events_sink_sid: sinkSid });
      // Twilio's own test event for a new sink: twilio-events records it and acts on nothing. Its
      // answer changes nothing here.
      if (fresh) await this.http("POST", `${EVENTS}/Sinks/${sinkSid}/Test`, auth, []).catch(() => {});
    }
    if (!this.row.events_subscription_sid) {
      const sink = String(this.row.events_sink_sid);
      const list = await tw(this.http, "events", "GET", `${EVENTS}/Subscriptions?${new URLSearchParams({ SinkSid: sink, PageSize: "50" })}`, auth);
      // deno-lint-ignore no-explicit-any
      const found = (Array.isArray(list?.subscriptions) ? list.subscriptions : []).find((s: any) =>
        String(s?.description ?? "") === this.clientId && /^DF[0-9a-f]{32}$/i.test(String(s?.sid ?? "")));
      let subSid: string;
      if (found) {
        subSid = String(found.sid);
      } else {
        const made = await tw(this.http, "events", "POST", `${EVENTS}/Subscriptions`, auth, [
          ["Description", this.clientId], ["SinkSid", sink],
          ...this.cfg.eventTypes.map((t): [string, string] => ["Types", JSON.stringify({ type: t, schema_version: 1 })]),
        ]);
        subSid = String(made?.sid ?? "");
        if (!/^DF[0-9a-f]{32}$/i.test(subSid)) throw new ProvisionError("events", "no_sid");
      }
      await this.write({ events_subscription_sid: subSid, provision_step: "verify" });
    }
  }

  // ── 7. Dialing permissions inherited, and the stored token accepted ──
  private async verify(auth: BasicAuth): Promise<void> {
    this.step = "verify";
    const settings = await tw(this.http, "verify", "GET", `${VOICE}/Settings`, auth);
    if (settings?.dialing_permissions_inheritance !== true) {
      throw new ProvisionError("verify", "dialing_permissions_not_inherited", 409);
    }
    const sid = String(this.row.account_sid);
    const token = (await this.creds()).auth_token;
    if (!token) throw new ProvisionError("verify", "token_missing");
    await tw(this.http, "verify", "GET", `${API}/Accounts/${sid}.json`, { user: sid, pass: token });
    await this.write({ status: "active", provision_step: "done", last_error: null });
  }
}

/** A push credential's FriendlyName inside the sub: the client_id and the kind, nothing else. */
export function pushName(clientId: string, kind: PushKind): string {
  return `${clientId}-${kind.replace("_", "-")}`;
}

// ── The operator console (phase 9) ────────────────────────────────────────────────────────

/** AC…1234: enough to match a console screen, not the SID. */
export function maskSid(sid: string | null | undefined): string | null {
  const s = String(sid ?? "");
  return s.length > 6 ? `${s.slice(0, 2)}…${s.slice(-4)}` : null;
}

export type TokenCheck = "ok" | "rejected" | "missing" | "unreachable" | "error";

export type AccountView = {
  switchOn: boolean;
  kind: "none" | "parent" | "sub";
  status: string | null;
  step: string | null;
  lastError: string | null;
  lockedUntil: string | null;
  accountSid: string | null;
  apiKeySid: string | null;
  twimlAppSid: string | null;
  push: Record<PushKind, boolean>;
  pushSkipped: string[];
  sink: boolean;
  subscription: boolean;
  /** Why this tenant stays on the parent (internal, or what it holds there), when it has no row. */
  parentReason: string | null;
  liveNumbers: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  tokenCheck?: { authToken: TokenCheck; apiKey: TokenCheck };
};

/** What the console card shows. Masked SIDs only; `check` asks Twilio whether the stored
 *  credentials are accepted (two GETs, nothing changed). */
export async function twilioAccountView(admin: Admin, clientId: string, opts: { get: EnvGet; http?: ProvisionHttp; check?: boolean }): Promise<AccountView> {
  const http = opts.http ?? fetchHttp;
  const res = await admin.from("twilio_accounts").select(ROW_COLUMNS).eq("client_id", clientId).maybeSingle();
  if (res?.error) throw new ProvisionError("config", `lookup_failed_${pgCode(res.error)}`);
  const row = (res?.data ?? null) as AccountRow | null;
  let parentWhy: string | null = null;
  if (!row) {
    const cs = await admin.from("client_settings").select("internal_account").eq("client_id", clientId).maybeSingle();
    if (cs?.data?.internal_account === true) parentWhy = "our internal account";
    else {
      const h = await admin.rpc("twilio_parent_holdings", { p_client_id: clientId });
      parentWhy = h?.error ? null : (h?.data ? String(h.data) : null);
    }
  }
  const nums = await admin.from("sms_numbers").select("id", { count: "exact", head: true }).eq("client_id", clientId).is("released_at", null);
  const view: AccountView = {
    switchOn: subaccountsOn(opts.get),
    kind: row ? row.kind : "none",
    status: row?.status ?? null,
    step: row?.provision_step ?? null,
    lastError: row?.last_error ?? null,
    lockedUntil: row?.provision_lock_until && Date.parse(row.provision_lock_until) > Date.now() ? row.provision_lock_until : null,
    accountSid: maskSid(row?.account_sid),
    apiKeySid: maskSid(row?.api_key_sid),
    twimlAppSid: maskSid(row?.twiml_app_sid),
    push: { apns_dev: !!row?.push_apns_dev_sid, apns_prod: !!row?.push_apns_prod_sid, fcm: !!row?.push_fcm_sid },
    pushSkipped: row?.push_skipped ?? [],
    sink: !!row?.events_sink_sid,
    subscription: !!row?.events_subscription_sid,
    parentReason: parentWhy,
    liveNumbers: nums?.error ? null : Number(nums?.count ?? 0),
    createdAt: row?.created_at ?? null,
    updatedAt: row?.updated_at ?? null,
  };
  if (opts.check && row?.kind === "sub" && row.account_sid) {
    const c = await admin.rpc("twilio_account_creds", { p_client_id: clientId });
    const r = (Array.isArray(c?.data) ? c.data[0] : c?.data) ?? {};
    const probe = async (user: string, pass: string | null): Promise<TokenCheck> => {
      if (c?.error) return "error";
      if (!pass) return "missing";
      try {
        const out = await http("GET", `${API}/Accounts/${row.account_sid}.json`, { user, pass });
        if (out.status >= 200 && out.status < 300) return "ok";
        return out.status === 401 || out.body?.code === 20003 ? "rejected" : "error";
      } catch {
        return "unreachable";
      }
    };
    view.tokenCheck = {
      authToken: await probe(String(row.account_sid), r.auth_token ? String(r.auth_token) : null),
      apiKey: row.api_key_sid ? await probe(row.api_key_sid, r.api_secret ? String(r.api_secret) : null) : "missing",
    };
  }
  return view;
}

export type StatusChange =
  | { ok: true; status: "active" | "suspended" | "closed"; already: boolean }
  | { ok: false; reason: "no_sub" | "not_configured" | "has_numbers" | "lookup_failed" | "twilio_failed" | "wrong_state"; status: number; code: string; numbers?: number };

/**
 * Suspend, reactivate or close a tenant's sub-account at Twilio, then record it. Done with the
 * PARENT's auth token (a sub cannot change its own status). ⚠️ CLOSING IS IRREVERSIBLE and releases
 * every number in the sub, so close REFUSES while the sub still has a number, by our rows or by
 * Twilio's own list (either one is enough; a failed read is a refusal).
 */
export async function setTwilioAccountStatus(
  admin: Admin, clientId: string, want: "active" | "suspended" | "closed", opts: { get: EnvGet; http?: ProvisionHttp; now?: () => number },
): Promise<StatusChange> {
  const http = opts.http ?? fetchHttp;
  const now = opts.now ?? Date.now;
  const res = await admin.from("twilio_accounts").select(ROW_COLUMNS).eq("client_id", clientId).maybeSingle();
  if (res?.error) return { ok: false, reason: "lookup_failed", status: 502, code: `lookup_failed_${pgCode(res.error)}` };
  const row = (res?.data ?? null) as AccountRow | null;
  if (!row || row.kind !== "sub" || !row.account_sid) return { ok: false, reason: "no_sub", status: 409, code: "no_sub" };
  if (row.status === want) return { ok: true, status: want, already: true };
  if (row.status === "closed") return { ok: false, reason: "wrong_state", status: 409, code: "closed" };
  if (want === "active" && row.status !== "suspended") return { ok: false, reason: "wrong_state", status: 409, code: row.status };
  const parentSid = String(opts.get("TWILIO_ACCOUNT_SID") ?? "").trim();
  const parentToken = String(opts.get("TWILIO_AUTH_TOKEN") ?? "").trim();
  if (!ACCOUNT_SID.test(parentSid) || !parentToken) {
    return { ok: false, reason: "not_configured", status: 503, code: parentToken ? "env_missing" : "parent_token_missing" };
  }
  const parentAuth = { user: parentSid, pass: parentToken };
  if (want === "closed") {
    const nums = await admin.from("sms_numbers").select("id", { count: "exact", head: true }).eq("client_id", clientId).is("released_at", null);
    if (nums?.error) return { ok: false, reason: "lookup_failed", status: 502, code: `numbers_${pgCode(nums.error)}` };
    let held = Number(nums?.count ?? 0);
    if (!held) {
      let r: { status: number; body: any };
      try {
        r = await http("GET", `${API}/Accounts/${row.account_sid}/IncomingPhoneNumbers.json?PageSize=1`, parentAuth);
      } catch {
        return { ok: false, reason: "twilio_failed", status: 502, code: "unreachable" };
      }
      if (r.status < 200 || r.status >= 300) {
        return { ok: false, reason: "twilio_failed", status: 502, code: typeof r.body?.code === "number" ? String(r.body.code) : `http_${r.status}` };
      }
      held = Array.isArray(r.body?.incoming_phone_numbers) ? r.body.incoming_phone_numbers.length : 0;
    }
    if (held) return { ok: false, reason: "has_numbers", status: 409, code: "has_numbers", numbers: held };
  }
  let r: { status: number; body: any };
  try {
    r = await http("POST", `${API}/Accounts/${row.account_sid}.json`, parentAuth, [["Status", want]]);
  } catch {
    return { ok: false, reason: "twilio_failed", status: 502, code: "unreachable" };
  }
  if (r.status < 200 || r.status >= 300) {
    return { ok: false, reason: "twilio_failed", status: 502, code: typeof r.body?.code === "number" ? String(r.body.code) : `http_${r.status}` };
  }
  const upd = await admin.from("twilio_accounts")
    .update({ status: want, updated_at: new Date(now()).toISOString(), ...(want === "closed" ? { provision_lock_until: null } : {}) })
    .eq("client_id", clientId).eq("kind", "sub").select("client_id");
  if (upd?.error || !Array.isArray(upd?.data) || !upd.data.length) {
    // Twilio has changed; our row has not. Said, so the operator knows to look (and a retry is safe:
    // the same status again is accepted by Twilio).
    return { ok: false, reason: "lookup_failed", status: 502, code: `recorded_failed_${pgCode(upd?.error)}` };
  }
  return { ok: true, status: want, already: false };
}

/** delete_client's last Twilio step: 295's twilio_account_forget. */
export async function forgetTwilioAccount(admin: Admin, clientId: string): Promise<{ ok: true; outcome: string } | { ok: false; code: string }> {
  const res = await admin.rpc("twilio_account_forget", { p_client_id: clientId });
  if (res?.error) return { ok: false, code: pgCode(res.error) };
  return { ok: true, outcome: String(res?.data ?? "none") };
}
