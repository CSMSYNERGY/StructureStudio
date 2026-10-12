// A new builder's own Twilio sub-account, made when the builder is created (call of 2026-10-12:
// "when a new subaccount is created in Structure Studio, the Twilio subaccount is also created
// automatically"). admin-catalog create_client calls provisionAtCreate once the tenant exists.
// Before this, a sub was made only at the builder's first number purchase (portal-settings
// phone_buy_number) or first texting submit (portal-sms advance); both still run
// ensureTwilioAccount, so anything this leaves unfinished is finished there.
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
// its lock has run out.
//
// RECORDS, as the console's Create does: an admin_audit row when the sub is made or the run is
// refused ("twilio_account_provision", note "at=create_client", the SID MASKED; a builder kept on
// the parent and a run another one is already doing get none), and an app_errors row for a run
// that did not finish (codes only: never a secret, never a Twilio message).
//
// NOT ON THE MONEY GRANT. The console's Create needs can_bill; this does not. With the switch "on"
// the builder's own first purchase or texting submit makes the same sub with no operator at all, so
// gating it here would only move the moment, and a sub-account costs nothing until a number is
// bought in it.

import { provisioningOn, subaccountsMode, type EnvGet } from "../_shared/twilioAccount.ts";
import { ensureTwilioAccount, maskSid, type EnsureOpts, type EnsureResult } from "../_shared/twilioProvision.ts";

/** What the create response says about the builder's Twilio account. */
export type AtCreateOutcome = "created" | "pending" | "skipped" | "failed";
export type AtCreateResult = { outcome: AtCreateOutcome; reason?: string; step?: string | null; code?: string };

/** How long the create waits for the answer before handing the run to waitUntil. */
export const AT_CREATE_WAIT_MS = 1_500;

/** One app_errors row (admin-catalog passes logEdgeError; it never throws). */
export type AtCreateLog = (row: {
  fn: string; clientId: string; code: string; severity: "error" | "info"; message: string; context: Record<string, unknown>;
}) => Promise<void>;

export type AtCreateDeps = {
  get: EnvGet;
  /** Who created the builder, for the audit row (admin-catalog's identity, without its grants). */
  actor: { via: string; email?: string | null; userId?: string | null };
  log: AtCreateLog;
  /** Tests only: the run, the wait and the runtime's waitUntil. */
  // deno-lint-ignore no-explicit-any
  ensure?: (admin: any, clientId: string, opts: EnsureOpts) => Promise<EnsureResult>;
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
  // Another run holds the lock: the sub is being made right now.
  if (r.reason === "busy") return { outcome: "pending", reason: "busy" };
  await audit(admin, clientId, deps.actor, `refused ${r.reason} step=${r.step ?? "-"} code=${r.code}`);
  const notConfigured = r.reason === "not_configured";
  await deps.log({
    fn: "admin-catalog", clientId,
    code: notConfigured ? "twilio_provision_not_configured" : "twilio_provision_failed",
    severity: notConfigured ? "info" : "error",
    message: notConfigured
      ? `Making the new builder's Twilio account needs ${(r.missing ?? []).join(", ")}${r.parentKeyOnly ? " (the parent's API key cannot create sub-accounts; set TWILIO_AUTH_TOKEN)" : ""}`
      : `The new builder's Twilio account was not finished at creation (${r.reason}, stopped at ${r.step ?? "start"}, ${r.code}); their first number or texting submit tries again`,
    context: { at: "create_client", reason: r.reason, step: r.step, code: r.code },
  }).catch(() => {});
  return { outcome: "failed", reason: r.reason, step: r.step, code: r.code };
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
          message: "The new builder's Twilio account was not finished at creation (an unexpected error); their first number or texting submit tries again",
          context: { at: "create_client", reason: "error", step: null, code: "threw" },
        }).catch(() => {});
        return { outcome: "failed", reason: "error", step: null, code: "threw" };
      }
      return await settle(admin, clientId, r, deps);
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
