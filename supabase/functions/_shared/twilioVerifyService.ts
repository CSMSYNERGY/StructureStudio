/**
 * Each builder's OWN Twilio Verify service, inside their own Twilio sub-account, named after them,
 * so the login code text a customer gets reads "Your <Builder> verification code is …" and not ours
 * (Carolyn's board item 72b1008c; Ahsan's call, 2026-10-21).
 *
 * WHY A SERVICE AND NOT A PARAMETER. Twilio's default Verify text puts the SERVICE's friendly name
 * in the message. The per-request override (CustomFriendlyName, "Custom Company Name") needs Twilio
 * Sales to switch it on, and without it Twilio refused every send that carried it (403/60204; see
 * twilioVerify.ts). A service per builder needs nobody's permission: every client builder already
 * has a sub-account of their own (migration 292, made 2026-10-12), a Verify service costs nothing
 * until a code is sent, and its SID is stored on their twilio_accounts row (migration 323).
 *
 * WHO GETS ONE: a tenant whose twilio_accounts row is kind 'sub' and 'active', and only while
 * TWILIO_SUBACCOUNTS is "on" or "manual" (off: nobody, nothing is read). structure-studio is on the
 * parent and keeps the parent's "Structure Studio" service, which is its real name. A builder whose
 * name sanitizes to nothing gets none (twSanitizeBrand) and stays on the parent's.
 *
 * IMPORTERS (deploy every one when this file changes):
 *   customer-auth/index.ts          builderVerifyTarget on every text code's start and check; a
 *                                   background syncVerifyService when the builder's name moved (the
 *                                   rename-on-change path) or their service refused as unusable (a
 *                                   repair). It never makes a first service: clearing the SID is the
 *                                   rollback, and the next login must not undo it
 *   admin-catalog/index.ts          twilio_account_provision (after ensureTwilioAccount),
 *                                   twilio_verify_sync (the console's "Sync login text name", one
 *                                   builder or all), twilio_account_get (the card's row)
 *   admin-catalog/twilioAtCreate.ts create_client, after the new builder's sub is made
 * Imports only twilioAccount.ts and twilioVerify.ts (both leaves). Every Twilio request goes through
 * an injectable `http`, so the tests drive every branch offline.
 *
 * ── WHAT syncVerifyService DOES, IDEMPOTENTLY ────────────────────────────────────────────
 *   1. Reads the row, the builder's name (client_settings.business_name, else client_configs.
 *      company_name: the pair customer-quotes and the portal header read) and the PARENT's service.
 *   2. Takes the provisioning lock (twilioProvision.ts's provision_lock_until, the same one
 *      conditional update), so it never runs beside a provisioning run or another sync.
 *   3. Lists the Verify services in the SUB, with the sub's own credentials (resolveTwilioAccount):
 *        the row's service is there                 → that one
 *        it is not (deleted in the console) or the row has none, and the sub holds one or more
 *                                                   → the oldest is ADOPTED (a create whose answer
 *                                                     was lost, or the row cleared by hand: the sub
 *                                                     belongs to this builder, so any service in it
 *                                                     is ours, and none is ever made twice)
 *        the sub holds none                         → one is made
 *   4. Makes its FriendlyName the builder's name and its settings the parent's (COPIED below:
 *      6-digit codes, no lookup, no do-not-share line, as the parent was set by hand on 2026-08-11),
 *      with ONE update carrying only what differs (a rename is one POST).
 *   5. Writes the SID and the name back under the lock, releasing it. A lost lock (the row suspended
 *      or deleted under it) writes nothing, and a service THIS run made is deleted again.
 * A renamed service keeps its SID, so a code already sent on it can still be checked.
 *
 * ⚠️ NOTHING HERE IS LOGGED OR RETURNED WITH A SECRET OR A TWILIO MESSAGE BODY: codes only.
 */

// deno-lint-ignore-file no-explicit-any -- Twilio JSON bodies and the supabase client, as in twilioProvision.ts
import { resolveTwilioAccount, subaccountsOn, TwilioAccountError, type EnvGet } from "./twilioAccount.ts";
import { parentVerifyTarget, twSanitizeBrand, type VerifyTarget } from "./twilioVerify.ts";

const VERIFY = "https://verify.twilio.com/v2";
const SERVICE_SID = /^VA[0-9a-f]{32}$/i;

/** One Twilio request's limit. Three requests at most run under the lock. */
export const VERIFY_SYNC_HTTP_TIMEOUT_MS = 15_000;
/** How long a sync may hold the provisioning lock (well over three timed-out requests). */
export const VERIFY_SYNC_LOCK_MS = 2 * 60_000;

export type VerifyAuth = { user: string; pass: string };
/** One Twilio request: the status and the parsed body (non-2xx included). REJECTS only when there
 *  was no answer at all. Same shape as twilioProvision.ts's ProvisionHttp. */
export type VerifyHttp = (
  method: "GET" | "POST" | "DELETE",
  url: string,
  auth: VerifyAuth,
  form?: Array<[string, string]>,
) => Promise<{ status: number; body: any }>;

export const fetchVerifyHttp: VerifyHttp = async (method, url, auth, form) => {
  const res = await fetch(url, {
    method,
    signal: AbortSignal.timeout(VERIFY_SYNC_HTTP_TIMEOUT_MS),
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

/**
 * The parent's settings a builder's service copies: Twilio's field → the form parameter. Booleans
 * and the code length only. Not copied: the TOTP / push / WhatsApp / passkeys blocks (login codes are
 * SMS only) and Verify event streams (none are set up on the parent).
 */
const COPIED_FLAGS: ReadonlyArray<[string, string]> = [
  ["code_length", "CodeLength"],
  ["lookup_enabled", "LookupEnabled"],
  ["skip_sms_to_landlines", "SkipSmsToLandlines"],
  ["do_not_share_warning_enabled", "DoNotShareWarningEnabled"],
  ["dtmf_input_required", "DtmfInputRequired"],
  ["psd2_enabled", "Psd2Enabled"],
  ["custom_code_enabled", "CustomCodeEnabled"],
];
/** Copied only when the parent has one set (an empty string is "none", never sent). */
const COPIED_STRINGS: ReadonlyArray<[string, string]> = [
  ["default_template_sid", "DefaultTemplateSid"],
  ["tts_name", "TtsName"],
];

/** The settings to give a builder's service, from the parent's service body, as Twilio field → the
 *  value Twilio reports back (what a diff compares against). */
export function copiedSettings(parent: any): Map<string, string | number | boolean> {
  const out = new Map<string, string | number | boolean>();
  for (const [field] of COPIED_FLAGS) {
    const v = parent?.[field];
    if (typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) out.set(field, v);
  }
  for (const [field] of COPIED_STRINGS) {
    const v = parent?.[field];
    if (typeof v === "string" && v.trim()) out.set(field, v.trim());
  }
  return out;
}

const FORM_NAME = new Map<string, string>([...COPIED_FLAGS, ...COPIED_STRINGS]);

/** The form for a create (everything) or an update (only what `current` does not already say). */
export function serviceForm(
  name: string, settings: Map<string, string | number | boolean>, current?: any,
): Array<[string, string]> {
  const form: Array<[string, string]> = [];
  if (!current || String(current.friendly_name ?? "") !== name) form.push(["FriendlyName", name]);
  for (const [field, value] of settings) {
    if (current && current[field] === value) continue;
    form.push([FORM_NAME.get(field)!, String(value)]);
  }
  return form;
}

/** The name a builder's service carries: business_name, else company_name, sanitized; "" = none. */
export function builderServiceName(businessName: unknown, companyName: unknown): string {
  return twSanitizeBrand(businessName) || twSanitizeBrand(companyName);
}

type Admin = any;
type Pg = { code?: string } | null | undefined;
const pgCode = (e: Pg) => String(e?.code ?? "no_code");
/** 42703 / PGRST204: a column is not there (migration 323 not applied). 42P01 / PGRST205: no table. */
const columnMissing = (e: Pg) => ["42703", "PGRST204", "42P01", "PGRST205"].includes(pgCode(e));

/** The builder's name, or null when it cannot be read. */
async function readBuilderName(admin: Admin, clientId: string): Promise<string | null> {
  const [bs, cfg] = await Promise.all([
    admin.from("client_settings").select("business_name").eq("client_id", clientId).maybeSingle(),
    admin.from("client_configs").select("company_name").eq("client_id", clientId).maybeSingle(),
  ]);
  if (bs?.error || cfg?.error) return null;
  return builderServiceName(bs?.data?.business_name, cfg?.data?.company_name);
}

const ROW_COLUMNS = "kind, status, verify_service_sid, verify_service_name";
type VerifyRow = { kind?: string | null; status?: string | null; verify_service_sid?: string | null; verify_service_name?: string | null };

// ── customer-auth: which service a login code uses ───────────────────────────────────────

export type BuilderVerify = {
  /** The builder's own service with the sub's credentials, or null: use the parent's. */
  target: VerifyTarget | null;
  /** The builder HAS a service, but it is named differently from the builder now: the caller may
   *  start a syncVerifyService in the background to rename it. Only asked with `checkName`. Never
   *  true for a builder with no service: only the console (Create, Sync) and a new builder's set-up
   *  MAKE one, so clearing the SID (the rollback) is never undone by the next login. */
  needsSync: boolean;
};

const NONE: BuilderVerify = { target: null, needsSync: false };

/**
 * The service a tenant's login codes go through. With the switch off: the parent, and nothing is
 * read. Otherwise one twilio_accounts read, plus the sub's credentials (twilio_account_creds) when
 * it has a service, plus the builder's name with `checkName` (the send path: a rename is noticed
 * there, never on the check). NEVER THROWS: any failure answers the parent's service, today's
 * behaviour, because a customer must never fail to get a code over a lookup.
 */
export async function builderVerifyTarget(
  admin: Admin, clientId: string, get: EnvGet, opts: { checkName?: boolean } = {},
): Promise<BuilderVerify> {
  if (!subaccountsOn(get)) return NONE;
  try {
    const read = await admin.from("twilio_accounts").select(ROW_COLUMNS).eq("client_id", clientId).maybeSingle();
    if (read?.error) return NONE;
    const row = (read?.data ?? null) as VerifyRow | null;
    if (!row || row.kind !== "sub" || row.status !== "active") return NONE;
    const sid = SERVICE_SID.test(String(row.verify_service_sid ?? "")) ? String(row.verify_service_sid) : null;
    const [account, name] = await Promise.all([
      sid ? resolveTwilioAccount(admin, clientId, get).catch(() => null) : Promise.resolve(null),
      opts.checkName ? readBuilderName(admin, clientId).catch(() => null) : Promise.resolve(null),
    ]);
    const target = sid && account && account.source === "sub" ? { serviceSid: sid, user: account.user, pass: account.pass } : null;
    const needsSync = !!sid && !!name && name !== String(row.verify_service_name ?? "");
    return { target, needsSync };
  } catch {
    return NONE;
  }
}

// ── syncVerifyService ────────────────────────────────────────────────────────────────────

export type VerifySyncResult =
  | {
    ok: true;
    /** created: made now; adopted: an existing service in the sub taken over; renamed: its name
     *  changed; updated: only its settings changed; unchanged: nothing to do. */
    outcome: "created" | "adopted" | "renamed" | "updated" | "unchanged";
    sid: string;
    name: string;
  }
  | {
    ok: false;
    reason:
      | "switch_off" | "not_sub" | "not_active" | "no_name" | "not_configured"
      | "busy" | "lookup_failed" | "twilio_failed" | "lock_lost";
    /** The status the console answers with: 409 for a state, 503 not configured, 502 the rest. */
    status: number;
    /** Ours or Twilio's numeric code, never a message. */
    code: string;
  };

type SyncFail = Extract<VerifySyncResult, { ok: false }>;
const fail = (reason: SyncFail["reason"], status: number, code: string): SyncFail => ({ ok: false, reason, status, code });

/** One Twilio request, its failure as a code. */
async function tw(
  http: VerifyHttp, method: "GET" | "POST" | "DELETE", url: string, auth: VerifyAuth, form?: Array<[string, string]>,
): Promise<{ ok: true; body: any } | { ok: false; code: string }> {
  let r: { status: number; body: any };
  try {
    r = await http(method, url, auth, form);
  } catch {
    return { ok: false, code: "unreachable" };
  }
  if (r.status >= 200 && r.status < 300) return { ok: true, body: r.body ?? {} };
  return { ok: false, code: typeof r.body?.code === "number" ? String(r.body.code) : `http_${r.status}` };
}

export type VerifySyncOpts = { get: EnvGet; http?: VerifyHttp; now?: () => number; lockMs?: number };

/** Make, adopt, rename or leave the builder's Verify service (see the header). Never throws. */
export async function syncVerifyService(admin: Admin, clientId: string, opts: VerifySyncOpts): Promise<VerifySyncResult> {
  try {
    return await syncInner(admin, clientId, opts);
  } catch {
    return fail("lookup_failed", 502, "threw");
  }
}

async function syncInner(admin: Admin, clientId: string, opts: VerifySyncOpts): Promise<VerifySyncResult> {
  if (!subaccountsOn(opts.get)) return fail("switch_off", 409, "switch_off");
  // Before any read: a deployment with no Verify service of its own has nothing to copy, and nothing
  // a customer could be texted with anyway.
  const parent = parentVerifyTarget();
  if (!parent) return fail("not_configured", 503, "parent_verify_missing");
  const http = opts.http ?? fetchVerifyHttp;
  const now = opts.now ?? Date.now;

  const read = await admin.from("twilio_accounts").select(ROW_COLUMNS).eq("client_id", clientId).maybeSingle();
  if (read?.error) {
    return columnMissing(read.error) ? fail("not_configured", 503, "migration_323_missing") : fail("lookup_failed", 502, `lookup_failed_${pgCode(read.error)}`);
  }
  const row = (read?.data ?? null) as VerifyRow | null;
  if (!row || row.kind !== "sub") return fail("not_sub", 409, row ? "parent" : "no_row");
  if (row.status !== "active") return fail("not_active", 409, String(row.status ?? "unknown"));

  const name = await readBuilderName(admin, clientId);
  if (name === null) return fail("lookup_failed", 502, "name_lookup_failed");
  if (!name) return fail("no_name", 409, "no_name");

  const parentSvc = await tw(http, "GET", `${VERIFY}/Services/${parent.serviceSid}`, { user: parent.user, pass: parent.pass });
  if (!parentSvc.ok) return fail("twilio_failed", 502, `parent_${parentSvc.code}`);
  const settings = copiedSettings(parentSvc.body);

  // ── The lock: twilioProvision.ts's own, one conditional update ──
  const lockMs = opts.lockMs ?? VERIFY_SYNC_LOCK_MS;
  const nowIso = new Date(now()).toISOString();
  const lockUntil = new Date(now() + lockMs).toISOString();
  const locked = await admin.from("twilio_accounts")
    .update({ provision_lock_until: lockUntil, updated_at: nowIso })
    .eq("client_id", clientId).eq("kind", "sub")
    .or(`provision_lock_until.is.null,provision_lock_until.lt.${nowIso}`)
    .select("client_id").maybeSingle();
  if (locked?.error) return fail("lookup_failed", 502, `lock_failed_${pgCode(locked.error)}`);
  if (!locked?.data) return fail("busy", 409, "busy");

  let made: string | null = null;
  let subAuth: VerifyAuth | null = null;
  let released = false;
  try {
    let account;
    try {
      account = await resolveTwilioAccount(admin, clientId, opts.get);
    } catch (e) {
      if (e instanceof TwilioAccountError && e.kind === "not_ready") return fail("not_active", 409, e.accountStatus ?? "not_ready");
      return fail("lookup_failed", 502, "creds_lookup_failed");
    }
    if (!account || account.source !== "sub") return fail("not_sub", 409, "parent");
    const auth: VerifyAuth = { user: account.user, pass: account.pass };
    subAuth = auth;

    const list = await tw(http, "GET", `${VERIFY}/Services?PageSize=50`, auth);
    if (!list.ok) return fail("twilio_failed", 502, `list_${list.code}`);
    const services: any[] = (Array.isArray(list.body?.services) ? list.body.services : [])
      .filter((s: any) => SERVICE_SID.test(String(s?.sid ?? "")));
    let svc = services.find((s) => String(s.sid) === String(row.verify_service_sid ?? "")) ?? null;
    let outcome: "created" | "adopted" | "renamed" | "updated" | "unchanged";
    if (!svc && services.length) {
      svc = [...services].sort((a, b) => String(a.date_created ?? "").localeCompare(String(b.date_created ?? "")))[0];
      outcome = "adopted";
    } else {
      outcome = "unchanged";
    }

    let sid: string;
    if (!svc) {
      const created = await tw(http, "POST", `${VERIFY}/Services`, auth, serviceForm(name, settings));
      if (!created.ok) return fail("twilio_failed", 502, `create_${created.code}`);
      sid = String(created.body?.sid ?? "");
      if (!SERVICE_SID.test(sid)) return fail("twilio_failed", 502, "create_no_sid");
      made = sid;
      outcome = "created";
    } else {
      sid = String(svc.sid);
      const form = serviceForm(name, settings, svc);
      if (form.length) {
        const upd = await tw(http, "POST", `${VERIFY}/Services/${sid}`, auth, form);
        if (!upd.ok) return fail("twilio_failed", 502, `update_${upd.code}`);
        if (outcome !== "adopted") outcome = form.some(([k]) => k === "FriendlyName") ? "renamed" : "updated";
      }
    }

    // ── Written under the lock, which this write also releases ──
    const wrote = await admin.from("twilio_accounts")
      .update({ verify_service_sid: sid, verify_service_name: name, provision_lock_until: null, updated_at: new Date(now()).toISOString() })
      .eq("client_id", clientId).eq("kind", "sub").eq("provision_lock_until", lockUntil).select("client_id");
    if (wrote?.error) return fail("lookup_failed", 502, `db_write_${pgCode(wrote.error)}`);
    if (!Array.isArray(wrote?.data) || !wrote.data.length) return fail("lock_lost", 409, "lock_lost");
    released = true;
    made = null;
    return { ok: true, outcome, sid, name };
  } finally {
    // A service this run made but could not record is removed, so the next run does not find two.
    // (One it could not remove is adopted by the next run: the oldest in the sub.)
    if (made && subAuth) {
      await http("DELETE", `${VERIFY}/Services/${made}`, subAuth).catch(() => {});
    }
    if (!released) {
      await Promise.resolve(admin.from("twilio_accounts").update({ provision_lock_until: null })
        .eq("client_id", clientId).eq("provision_lock_until", lockUntil)).catch(() => {});
    }
  }
}

/** The sentence the console shows for a sync that did not finish. */
export function verifySyncSentence(r: SyncFail): string {
  switch (r.reason) {
    case "switch_off": return "Sub-accounts are switched off (TWILIO_SUBACCOUNTS), so every login text uses our main service.";
    case "not_sub": return "This builder is on our main Twilio account, so their login texts use our main service.";
    case "not_active": return `This builder's Twilio account is ${r.code}, so their login texts use our main service until it is active.`;
    case "no_name": return "This builder has no business name we can put in a text, so their login texts use our main service.";
    case "not_configured": return r.code === "migration_323_missing"
      ? "Migration 323 isn't applied on this database yet."
      : "Twilio Verify isn't configured on this server.";
    case "busy": return "This builder's Twilio account is being set up right now. Try again in a minute.";
    case "lock_lost": return "This builder's Twilio account changed while the login text name was being set. Try again.";
    default: return `Couldn't set the login text name (${r.code}). Their login texts keep using the service they had.`;
  }
}
