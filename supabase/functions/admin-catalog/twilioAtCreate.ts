// A new builder's own Twilio sub-account, made when the builder is created (call of 2026-10-12:
// "when a new subaccount is created in Structure Studio, the Twilio subaccount is also created
// automatically"). admin-catalog create_client calls provisionAtCreate once the tenant exists.
// Before this, a sub was made only at the builder's first number purchase (portal-settings
// phone_buy_number) or first texting submit (portal-sms advance).
//
// WHAT FINISHES A RUN THIS LEAVES UNFINISHED. The row it leaves is a sub at 'failed' or
// 'provisioning', and resolveTwilioAccount refuses every sub that is not active ("still being set
// up"), so only something that runs ensureTwilioAccount first gets the builder out: the number
// search on the Phone tab and on the Text Messaging tab (portal-settings phone_search_numbers,
// portal-sms search_numbers: the Phone tab can only buy a number its search found), the purchase,
// a texting submit, or the console card's Create. Each resumes from the step the run reached.
//
// WHEN: only with TWILIO_SUBACCOUNTS "on" (provisioningOn). Off and "manual" answer "skipped" and
// nothing is read or written: off is today, and "manual" means only the console's Create makes a
// sub. ensureTwilioAccount runs with the console's own options ({ get, operator: true }), so every
// rule it keeps is kept here too: a pinned tenant, our internal account and one already holding
// something on the parent stay on the parent ("skipped"), and the lock means two runs never make
// the same object.
//
// NEVER FAILS OR HOLDS UP THE CREATE. The tenant is fully made before this runs, and nothing here
// throws. The create waits at most AT_CREATE_WAIT_MS: that is enough for the answers that need no
// Twilio call (skipped, not configured, a failed read), not for a whole run (about twenty Twilio
// requests). A run still going then is handed to EdgeRuntime.waitUntil and the create answers
// "pending"; the console's Twilio account card shows where it got to. A worker killed under it
// leaves the row at the step it reached, and the next ensureTwilioAccount resumes from there once
// its lock has run out. While the lock is held, delete_client refuses (a run could otherwise make
// the sub at Twilio after the delete had looked and found none).
//
// RECORDS, as the console's Create does: an admin_audit row when the sub is made or the run is
// refused ("twilio_account_provision", note "at=create_client", the SID MASKED; a builder kept on
// the parent and a run another one is already doing get none), and an app_errors row for a run
// that did not finish (codes only: never a secret, never a Twilio message).
//
// THE LOGIN TEXT NAME (2026-10-21, migration 323): once the sub is made, the builder's own Verify
// service is made in it too (_shared/twilioVerifyService.ts syncVerifyService), so their customers'
// login codes name them from the first one. Inside the same waitUntil'd run, after the sub's own
// audit row; one admin_audit row ("twilio_verify_sync") when it is made, one warn row when it could
// not be (the card's "Sync login text name" makes it later). A deployment with no Verify service,
// a builder with no usable name, or a lock held by another run file nothing.
//
// NOT ON THE MONEY GRANT, ON PURPOSE (admin-catalog's can_bill block names this exception). The
// console's Create needs can_bill; create_client needs can_write. With the switch "on" the builder's
// own number search, purchase or texting submit makes the same sub with no operator at all, so
// gating it here would only move the moment, and a sub-account costs nothing until a number is
// bought in it (which needs the money grant wherever it happens).

import { provisioningOn, subaccountsMode, type EnvGet } from "../_shared/twilioAccount.ts";
import { ensureTwilioAccount, maskSid, type EnsureOpts, type EnsureResult } from "../_shared/twilioProvision.ts";
import { syncVerifyService, type VerifySyncOpts, type VerifySyncResult } from "../_shared/twilioVerifyService.ts";

/** What the create response says about the builder's Twilio account. */
export type AtCreateOutcome = "created" | "pending" | "skipped" | "failed";
export type AtCreateResult = { outcome: AtCreateOutcome; reason?: string; step?: string | null; code?: string };

/** How long the create waits for the answer before handing the run to waitUntil. */
export const AT_CREATE_WAIT_MS = 1_500;

/** One app_errors row (admin-catalog passes logEdgeError; it never throws). */
export type AtCreateLog = (row: {
  fn: string; clientId: string; code: string; severity: "error" | "warn" | "info"; message: string; context: Record<string, unknown>;
}) => Promise<void>;

export type AtCreateDeps = {
  get: EnvGet;
  /** Who created the builder, for the audit row (admin-catalog's identity, without its grants). */
  actor: { via: string; email?: string | null; userId?: string | null };
  log: AtCreateLog;
  /** Tests only: the run, the wait and the runtime's waitUntil. */
  // deno-lint-ignore no-explicit-any
  ensure?: (admin: any, clientId: string, opts: EnsureOpts) => Promise<EnsureResult>;
  /** Tests only: the login text service's sync (syncVerifyService). */
  // deno-lint-ignore no-explicit-any
  syncVerify?: (admin: any, clientId: string, opts: VerifySyncOpts) => Promise<VerifySyncResult>;
  waitMs?: number;
  keepAlive?: (p: Promise<unknown>) => void;
};

// The Supabase edge runtime's waitUntil, where there is one (_shared/heartbeatJson.ts keepAlive's
// shape). Deno's test runner has none, and the promise just runs.
function edgeKeepAlive(p: Promise<unknown>): void {
  try {
    // deno-lint-ignore no-explicit-any
    (globalThis as any).EdgeRuntime?.waitUntil?.(p);
  } catch { /* the promise runs on either way */ }
}

// deno-lint-ignore no-explicit-any
async function audit(admin: any, clientId: string, actor: AtCreateDeps["actor"], outcome: string): Promise<void> {
  try {
    await admin.from("admin_audit").insert({
      action: "twilio_account_provision", target_client_id: clientId,
      actor_email: actor.via === "operator" ? actor.email ?? null : null,
      actor_user_id: actor.via === "operator" ? actor.userId ?? null : null,
      note: `via=${actor.via} at=create_client ${outcome}`.slice(0, 2000),
    });
  } catch (_e) { /* best-effort: the outcome is also in the response and on the console card */ }
}

/** The app_errors rows' last words: what finishes a run left unfinished (see the header). */
const FINISHED_BY = "the builder's number search, a purchase, a texting submit or the console card's Create finishes it";

/** What a finished run means for the create, with its audit row and its app_errors row. */
// deno-lint-ignore no-explicit-any
async function settle(admin: any, clientId: string, r: EnsureResult, deps: AtCreateDeps): Promise<AtCreateResult> {
  if (r.ok && r.kind === "sub") {
    await audit(admin, clientId, deps.actor,
      `${r.ran ? "provisioned" : "already_active"} sid=${maskSid(r.accountSid)}${r.pushSkipped.length ? ` push_skipped=${r.pushSkipped.join(",")}` : ""}`);
    return { outcome: "created" };
  }
  // Stays on the parent by rule (a pin, our internal account, something already held there).
  if (r.ok) return { outcome: "skipped", reason: r.reason };
  // Another run held the lock from the start: the sub is being made right now. A lock lost MID-run
  // (code lock_lost: the row suspended, closed or deleted under it) is not that: Twilio may already
  // hold a sub nobody records, so it is filed below like any other run that did not finish.
  if (r.reason === "busy" && r.code !== "lock_lost") return { outcome: "pending", reason: "busy" };
  await audit(admin, clientId, deps.actor, `refused ${r.reason} step=${r.step ?? "-"} code=${r.code}`);
  const notConfigured = r.reason === "not_configured";
  await deps.log({
    fn: "admin-catalog", clientId,
    code: notConfigured ? "twilio_provision_not_configured" : "twilio_provision_failed",
    severity: notConfigured ? "info" : "error",
    message: notConfigured
      ? `Making the new builder's Twilio account needs ${(r.missing ?? []).join(", ")}${r.parentKeyOnly ? " (the parent's API key cannot create sub-accounts; set TWILIO_AUTH_TOKEN)" : ""}`
      : r.code === "lock_lost"
      ? `The new builder's Twilio account run lost its lock at ${r.step ?? "start"} (the row was suspended, closed or deleted under it); look in Twilio for a sub-account named for this client id that no row records`
      : `The new builder's Twilio account was not finished at creation (${r.reason}, stopped at ${r.step ?? "start"}, ${r.code}); ${FINISHED_BY}`,
    context: { at: "create_client", reason: r.reason, step: r.step, code: r.code },
  }).catch(() => {});
  return { outcome: "failed", reason: r.reason, step: r.step, code: r.code };
}

/** The new builder's own login text service, once their sub is ready. Never throws. */
// deno-lint-ignore no-explicit-any
async function verifyAtCreate(admin: any, clientId: string, deps: AtCreateDeps): Promise<void> {
  let v: VerifySyncResult;
  try {
    v = await (deps.syncVerify ?? syncVerifyService)(admin, clientId, { get: deps.get });
  } catch (_e) {
    v = { ok: false, reason: "lookup_failed", status: 502, code: "threw" };
  }
  if (v.ok) {
    try {
      await admin.from("admin_audit").insert({
        action: "twilio_verify_sync", target_client_id: clientId,
        actor_email: deps.actor.via === "operator" ? deps.actor.email ?? null : null,
        actor_user_id: deps.actor.via === "operator" ? deps.actor.userId ?? null : null,
        note: `via=${deps.actor.via} at=create_client ${v.outcome} sid=${maskSid(v.sid)} name=${v.name}`.slice(0, 2000),
      });
    } catch (_e) { /* best-effort */ }
    return;
  }
  if (["not_configured", "no_name", "busy", "switch_off"].includes(v.reason)) return;
  await deps.log({
    fn: "admin-catalog", clientId, code: "twilio_verify_sync_failed", severity: "warn",
    message: `The new builder's login text service was not made at creation (${v.reason}, ${v.code}); their codes use our main service until the console's "Sync login text name" makes it`,
    context: { at: "create_client", reason: v.reason, code: v.code },
  }).catch(() => {});
}

/**
 * Make the new builder's sub-account if the switch says so. Resolves with what to tell the caller;
 * never rejects, and never waits longer than the wait (see the header).
 */
// deno-lint-ignore no-explicit-any
export async function provisionAtCreate(admin: any, clientId: string, deps: AtCreateDeps): Promise<AtCreateResult> {
  try {
    if (!provisioningOn(deps.get)) {
      return { outcome: "skipped", reason: subaccountsMode(deps.get) === "manual" ? "manual" : "switch_off" };
    }
    const ensure = deps.ensure ?? ensureTwilioAccount;
    const work: Promise<AtCreateResult> = (async (): Promise<AtCreateResult> => {
      let r: EnsureResult;
      try {
        r = await ensure(admin, clientId, { get: deps.get, operator: true });
      } catch (_e) {
        // ensureTwilioAccount answers rather than throws; one that throws anyway is filed and survived.
        await deps.log({
          fn: "admin-catalog", clientId, code: "twilio_provision_failed", severity: "error",
          message: `The new builder's Twilio account was not finished at creation (an unexpected error); ${FINISHED_BY}`,
          context: { at: "create_client", reason: "error", step: null, code: "threw" },
        }).catch(() => {});
        return { outcome: "failed", reason: "error", step: null, code: "threw" };
      }
      const out = await settle(admin, clientId, r, deps);
      if (r.ok && r.kind === "sub") await verifyAtCreate(admin, clientId, deps);
      return out;
    })().catch((): AtCreateResult => ({ outcome: "failed", reason: "error", step: null, code: "threw" }));
    // Registered before the wait, so the runtime keeps the worker for the audit and error rows too.
    (deps.keepAlive ?? edgeKeepAlive)(work);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const first = await Promise.race([
      work,
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), deps.waitMs ?? AT_CREATE_WAIT_MS); }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    return first ?? { outcome: "pending" };
  } catch (_e) {
    return { outcome: "failed", reason: "error", step: null, code: "threw" };
  }
}
