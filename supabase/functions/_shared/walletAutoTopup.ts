// _shared/walletAutoTopup.ts — the unattended wallet recharge, as ONE function (migration 164).
//
// Moved here from portal-settings (the block after a 3D generation's wallet hold) in 2026-10,
// when phone usage billing (259) gave it a second and third caller:
//   portal-settings   after a successful wallet_hold — the original trigger, unchanged
//   wallet-autotopup  the HTTP door the Worker's usage cron and the SMS/call refusals knock on
//                     (_shared/usageGate.ts requestAutoTopup)
// Same rule for all of them: the threshold, the cooldown and the card are decided by
// autoTopupDecision, the money moves through chargeTopup, and a decline switches the feature
// off. Two copies of that would be two answers to "why did my card get charged twice?".
//
// NEVER THROWS. Every caller runs this after the thing it was doing has already succeeded (a
// generation authorised, a usage charge posted) or while telling the builder "you're being
// topped up". A declined card, an unreachable gateway or a bad config must not fail any of
// those. Everything here is caught, logged under the caller's function name, and reported as
// a result the caller is free to ignore.
//
// ⚠️ Duplication ledger: this module is bundled per function. A change here means redeploying
// EVERY importer in the same push — derive them with the import-parsing command in taxMeter.ts's
// header, never from this comment.
//
// TWO DELIBERATE DIFFERENCES from the block as it stood in portal-settings, both because the
// new callers make concurrency ordinary rather than rare (a builder pressing Send three times on
// an empty wallet is three requests within a second):
//   1. THE COOLDOWN STAMP IS A CLAIM. It used to be read, decided, then written unconditionally,
//      so two requests that both read "not cooling down" both stamped and both went to charge.
//      Now the write only lands when the stored stamp is still outside the cooldown, and the
//      request whose write matched no row stands down. One charge per hour, decided by the
//      database, not by who read first.
//   2. "ANOTHER TOP-UP IS IN PROGRESS" IS NOT A DECLINE. chargeTopup answers it non-blocking,
//      like a decline, and the old block switched auto top-up OFF on it — so a builder pressing
//      Add funds while a text refusal asked for a top-up would find auto top-up disabled with
//      that sentence as the reason. Now it is left on and logged as info.

import { autoTopupDecision, AUTO_TOPUP_COOLDOWN_MS, chargeTopup } from "./walletTopup.ts";
import { logEdgeError } from "./logError.ts";
import { timingSafeEqual } from "./emailInbound.ts";

// deno-lint-ignore no-explicit-any
type Admin = any;

export type AutoTopupOutcome = {
  /** A card charge was attempted (chargeTopup was called). */
  fired: boolean;
  /** Nothing went wrong. True for a considered decision not to fire. */
  ok: boolean;
  /**
   * autoTopupDecision's reason when it did not fire ("not enabled", "cooling down", …), or one
   * of: charged | claimed_elsewhere | stamp_failed | in_progress | declined | needs_review |
   * crashed. Fixed strings only — never the gateway's text, which goes to app_errors.
   */
  reason: string;
};

/** Seams for tests. Production callers pass at most `fn`. */
export type AutoTopupDeps = {
  /** The function name app_errors rows are filed under (source `edge:<fn>`). */
  fn?: string;
  chargeTopup?: typeof chargeTopup;
  logError?: typeof logEdgeError;
  now?: () => number;
};

/** Matches chargeTopup's two "already in progress" refusals (walletTopup.ts, steps 2 and 3). */
const IN_PROGRESS = /already in progress/i;

/**
 * Check the tenant's auto top-up and, if it is due, charge it. Awaited by every caller: a money
 * path must not lean on a runtime keeping a background task alive (a task dropped on shutdown
 * mid-sale leaves a closed_unknown that blocks ALL future top-ups). Costs up to nmiPost's 30 s
 * when it fires; the cooldown caps that at once an hour.
 */
export async function runAutoTopup(
  admin: Admin,
  clientId: string,
  req?: Request | null,
  deps: AutoTopupDeps = {},
): Promise<AutoTopupOutcome> {
  const fn = deps.fn ?? "wallet-autotopup";
  const log = deps.logError ?? logEdgeError;
  const charge = deps.chargeTopup ?? chargeTopup;
  const now = deps.now ?? Date.now;
  try {
    const [{ data: acct }, { data: cust }] = await Promise.all([
      admin.from("wallet_accounts")
        .select("balance_cents, held_cents, auto_topup_enabled, auto_topup_threshold_cents, auto_topup_amount_cents, auto_topup_last_at")
        .eq("client_id", clientId).maybeSingle(),
      admin.from("billing_customers").select("vault_id").eq("client_id", clientId).maybeSingle(),
    ]);
    // Bind the vault id BEFORE the decision so its presence is provable rather than
    // implied: autoTopupDecision refuses without a card, but the type checker cannot know
    // that, and a non-null assertion on a money path is a comment pretending to be code.
    const vaultId = cust?.vault_id ? String(cust.vault_id) : "";
    const t = now();
    const decision = autoTopupDecision(acct, Boolean(vaultId), t);
    if (!decision.fire) return { fired: false, ok: true, reason: decision.reason };
    if (!vaultId) return { fired: false, ok: true, reason: "no card on file" };

    // Stamp the cooldown BEFORE charging, not after. A burst can cross the threshold several
    // times in seconds; the failure to design against is five recharges, not a late one. If the
    // charge then fails, the stamp costs at most an hour's delay before the next attempt.
    //
    // AS A CLAIM (difference 1 in the header): the update only matches a row whose stamp is
    // still outside the cooldown — the same rule autoTopupDecision just applied, re-checked by
    // the database at write time. Zero rows back means another request claimed this hour
    // between our read and our write, and that request is the one that charges.
    const cutoff = new Date(t - AUTO_TOPUP_COOLDOWN_MS).toISOString();
    const { data: claimed, error: stampErr } = await admin.from("wallet_accounts")
      .update({ auto_topup_last_at: new Date(t).toISOString() })
      .eq("client_id", clientId)
      .or(`auto_topup_last_at.is.null,auto_topup_last_at.lte.${cutoff}`)
      .select("client_id");
    if (stampErr) {
      // Unknown whether the stamp landed, so do not charge: an unrecorded cooldown is how one
      // empty wallet becomes several sales. The next trigger tries again.
      await log({ fn, req, clientId, code: "auto_topup_stamp_failed", message: `Auto top-up not attempted: the cooldown could not be recorded: ${stampErr.message}` });
      return { fired: false, ok: false, reason: "stamp_failed" };
    }
    if (!Array.isArray(claimed) || claimed.length === 0) {
      return { fired: false, ok: true, reason: "claimed_elsewhere" };
    }

    const r = await charge(admin, {
      clientId, vaultId, amountCents: decision.amountCents,
      actorUserId: null, auto: true,
    });
    if (r.ok) return { fired: true, ok: true, reason: "charged" };

    if (!r.blocking && IN_PROGRESS.test(String(r.error))) {
      // Difference 2 in the header: someone else's top-up holds the attempt slot. Nothing was
      // charged and nothing is wrong with the card, so auto top-up stays ON.
      await log({ fn, req, clientId, code: "auto_topup_in_progress", severity: "info", message: `Auto top-up skipped, another top-up was already running: ${r.error}` });
      return { fired: true, ok: false, reason: "in_progress" };
    }
    if (!r.blocking) {
      // A DECLINE switches auto-recharge off rather than retrying hourly forever. An
      // expired card declines identically every time, and a loop against it earns real
      // declines on the merchant account. The Billing tab shows this reason; turning it
      // back on is a human act.
      await admin.from("wallet_accounts")
        .update({ auto_topup_enabled: false, auto_topup_disabled_reason: String(r.error).slice(0, 300) })
        .eq("client_id", clientId);
      await log({ fn, req, clientId, code: "auto_topup_declined", message: `Auto top-up declined, switched off: ${r.error}` });
      return { fired: true, ok: false, reason: "declined" };
    }
    // Blocking (gateway-unknown, or charged-but-not-credited). Leave it ENABLED:
    // the closed_unknown attempt row already blocks every further top-up, and
    // support's reconciliation is what should restore normal service — switching it
    // off here would make a resolved incident look like a card problem.
    await log({ fn, req, clientId, code: "auto_topup_unresolved", message: `Auto top-up needs a human: ${r.error}` });
    return { fired: true, ok: false, reason: "needs_review" };
  } catch (e) {
    await log({ fn, req, clientId, code: "auto_topup_crashed", message: `Auto top-up check failed (the request that triggered it is unaffected): ${(e as Error)?.message ?? String(e)}` })
      .catch(() => undefined);
    return { fired: false, ok: false, reason: "crashed" };
  }
}

/**
 * Who may knock on wallet-autotopup: a bearer equal to the edge runtime's own service-role key
 * (what an edge function sends through usageGate.requestAutoTopup), or to WALLET_AUTOTOPUP_SECRET
 * when that is set.
 *
 * WHY TWO. The key the edge runtime is given and the key anything OUTSIDE the runtime holds are
 * not guaranteed to be the same string (seen live 2026-08-06: the CLI's legacy service_role JWT
 * passed the gateway and failed an equality check against the runtime's). The Worker holds its
 * own key, so for the Worker's calls set WALLET_AUTOTOPUP_SECRET to that exact value on the
 * Supabase side. Compared in constant time; an empty secret never matches.
 *
 * THIRD DOOR, `gatewayVerified`: a JWT whose `role` claim is service_role. The Worker's key
 * cannot be read back out of Cloudflare to copy into WALLET_AUTOTOPUP_SECRET, so equality alone
 * left the Worker's top-ups depending on a string nobody can check. The claim is only proof
 * because the Supabase gateway has ALREADY verified the token's signature (verify_jwt = true for
 * this function in config.toml), and nothing but the project's service key carries that role.
 * The caller passes `gatewayVerified: true` only for that reason; a source test pins the
 * config line, because with verify_jwt off this claim is forgeable by anyone.
 */
export function autoTopupCallerAllowed(
  authorization: string | null | undefined,
  keys: { serviceKey?: string | null; secret?: string | null; gatewayVerified?: boolean },
): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(String(authorization ?? "").trim());
  const presented = m ? m[1].trim() : "";
  if (!presented) return false;
  let ok = false;
  for (const k of [keys.serviceKey, keys.secret]) {
    // No short-circuit, so the time taken does not say which key (if either) matched.
    if (k && timingSafeEqual(presented, k)) ok = true;
  }
  if (keys.gatewayVerified === true && jwtRole(presented) === "service_role") ok = true;
  return ok;
}

/** The `role` claim of a JWT-shaped string, or null. Decodes only; it does NOT verify. */
export function jwtRole(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)));
    return json && typeof json.role === "string" ? json.role : null;
  } catch {
    return null;
  }
}
