// _shared/walletTopup.ts — put real money into the prepaid wallet, exactly once.
//
// ONE implementation, two callers that must never diverge:
//   portal-billing  `topup`        — a builder (or an operator) pressing Add funds
//   portal-settings  auto-recharge — unattended, when a 3D hold drops them under threshold
//
// Both move the same money through the same gateway into the same ledger, so they are the
// same function. The only thing that differs is `auto`, which changes the memo and nothing
// else about the mechanics.
//
// ⚠️ Duplication ledger — the attempt-ledger choreography below (closed_unknown block, stale
//    open promotion, insert-as-concurrency-guard, closeAttempt) is a deliberate mirror of the
//    subscribe loop in portal-billing/index.ts. That code is the original and predates this
//    module; it stayed inline because it is interleaved with per-plan subscription unwinding
//    that has no meaning here. If you change the double-charge posture in one, change both.
//
// THE ORDERING RULE, which is the whole point of this file: the charge attempt exists in OUR
// records BEFORE the card is touched, and the wallet is credited only AFTER the sale is known
// to have succeeded. Every failure between those points is recorded as a state a human can
// resolve, never guessed at.

import { nmiPost, isGatewayUnknown } from "./nmi.ts";

// $20 floor (one 3D generation — the cheapest top-up that buys anything) and a $5,000 typo
// cap, matching the per-entry cap admin-catalog applies to operator grants. Exported so the
// edge functions validate against these and the browser is TOLD them rather than hardcoding.
export const MIN_TOPUP_CENTS = 2000;
export const MAX_TOPUP_CENTS = 500000;

// The synthetic plan id every top-up attempt is filed under. billing_charge_attempts.plan_id
// is `text not null` with no foreign key, so this needs no schema change — but it does mean
// all top-ups for a tenant share one slot in the `(client_id, plan_id) where state = 'open'`
// unique index. Two consequences, both wanted:
//   * two simultaneous top-ups: the second is refused before it can charge.
//   * one unverifiable top-up blocks ALL later ones for that tenant until support clears it.
// The second is a real cost — a stuck row means auto-recharge stops too — accepted because
// the alternative is charging a card we already might have charged.
export const TOPUP_PLAN_ID = "wallet_topup";

export type TopupResult =
  | { ok: true; balanceCents: number; saleTxn: string | null; alreadyCredited: boolean }
  | { ok: false; error: string; blocking: boolean };

// deno-lint-ignore no-explicit-any
type Admin = any;

/**
 * Charge `amountCents` to the tenant's vaulted card and credit the wallet.
 * Never throws: every outcome is a TopupResult the caller can render or log.
 * `blocking: true` means DO NOT retry automatically — a human has to look.
 */
export async function chargeTopup(admin: Admin, opts: {
  clientId: string;
  vaultId: string;
  amountCents: number;
  actorUserId?: string | null;
  auto: boolean;
}): Promise<TopupResult> {
  const { clientId, vaultId, amountCents, auto } = opts;
  const actor = opts.actorUserId ?? null;

  if (!Number.isInteger(amountCents) || amountCents < MIN_TOPUP_CENTS || amountCents > MAX_TOPUP_CENTS) {
    return { ok: false, error: "That top-up amount isn't allowed.", blocking: false };
  }
  if (!vaultId) return { ok: false, error: "No card on file.", blocking: false };

  // 1. A prior attempt whose outcome we could not verify blocks this one entirely.
  const { data: unknownPrior } = await admin.from("billing_charge_attempts")
    .select("id").eq("client_id", clientId).eq("plan_id", TOPUP_PLAN_ID).eq("state", "closed_unknown").limit(1);
  if (unknownPrior && unknownPrior.length) {
    return {
      ok: false,
      error: "A previous wallet top-up could not be verified. To avoid a double charge, contact CSM Synergy before trying again.",
      blocking: true,
    };
  }

  // 2. An 'open' attempt older than 10 minutes means a top-up died mid-flight — the one
  //    failure nothing below can observe. That is exactly as unknown as a lost gateway
  //    response, so promote it rather than leaving it blocking behind "in progress".
  const { data: staleOpen } = await admin.from("billing_charge_attempts")
    .select("id, created_at").eq("client_id", clientId).eq("plan_id", TOPUP_PLAN_ID).eq("state", "open").limit(1);
  if (staleOpen && staleOpen.length) {
    const ageMs = Date.now() - Date.parse(staleOpen[0].created_at);
    if (ageMs > 10 * 60 * 1000) {
      await admin.from("billing_charge_attempts")
        .update({ state: "closed_unknown", detail: "stale open top-up - died mid-flight; verify at the gateway", closed_at: new Date().toISOString() })
        .eq("id", staleOpen[0].id).eq("state", "open");
      return {
        ok: false,
        error: "A previous wallet top-up did not finish and could not be verified. To avoid a double charge, contact CSM Synergy before trying again.",
        blocking: true,
      };
    }
    return { ok: false, error: "Another top-up is already in progress. Give it a moment, then refresh.", blocking: false };
  }

  // 3. Insert 'open' — also the concurrency guard, via the partial unique index.
  const { data: attempt, error: attErr } = await admin.from("billing_charge_attempts")
    .insert({ client_id: clientId, plan_id: TOPUP_PLAN_ID, orderid: `ss_topup_${clientId}_${Date.now()}` })
    .select("id").maybeSingle();
  if (attErr || !attempt) {
    return { ok: false, error: "Another top-up is already in progress. Give it a moment, then refresh.", blocking: false };
  }
  const closeAttempt = (state: string, detail: string | null, txn: string | null) =>
    admin.from("billing_charge_attempts")
      .update({ state, detail, sale_txn: txn, closed_at: new Date().toISOString() })
      .eq("id", attempt.id).then(() => undefined, () => undefined);

  // 4. The sale.
  let saleTxn: string | null = null;
  try {
    const sale = await nmiPost({
      type: "sale",
      amount: (amountCents / 100).toFixed(2),
      customer_vault_id: vaultId,
      orderid: `ss_topup_${clientId}_${attempt.id}`,
      merchant_defined_field_1: clientId,
      order_description: `StructureStudio wallet top-up${auto ? " (automatic)" : ""}`,
    });
    saleTxn = sale.transactionid || null;
  } catch (se) {
    if (isGatewayUnknown(se)) {
      // The card MAY have been charged and we cannot know. Do not credit, do not retry.
      await closeAttempt("closed_unknown", `top-up sale unverifiable: ${(se as Error).message}`, null);
      await admin.from("app_errors").insert({
        source: "edge:wallet-topup", severity: "error", code: "wallet_topup_unknown",
        message: `${clientId}: ${amountCents} cent top-up outcome unverifiable - check the gateway before allowing another. ${(se as Error).message}`,
        client_id: clientId,
      }).then(() => undefined, () => undefined);
      return {
        ok: false,
        error: "We could not confirm whether your card was charged. Do NOT try again - contact CSM Synergy and we will confirm and finish the top-up.",
        blocking: true,
      };
    }
    // A plain decline: the gateway answered, nothing was charged. Safe to say so.
    await closeAttempt("closed_declined", (se as Error).message, null);
    return { ok: false, error: (se as Error).message, blocking: false };
  }

  // 5. Credit the wallet. Keyed on the gateway transaction id, so a replay of this exact sale
  //    can never double-credit.
  //
  //    The `nmi_sale:` prefix is not decoration. wallet_credit and wallet_hold SHARE one
  //    unique index on (client_id, idempotency_key) — a bare transaction id could in
  //    principle collide with a generation's key and silently no-op the credit.
  const idem = `nmi_sale:${saleTxn ?? `att${attempt.id}`}`;
  try {
    const { data: bal, error: credErr } = await admin.rpc("wallet_credit", {
      p_client_id: clientId,
      p_amount_cents: amountCents,
      p_kind: "topup",
      p_ref_type: "nmi_sale",
      p_ref_id: saleTxn,
      p_memo: auto ? "Automatic top-up" : "Card top-up",
      p_idem: idem,
      p_actor: actor,
    });
    if (credErr) throw new Error(credErr.message);
    await closeAttempt("closed_ok", auto ? "auto top-up" : null, saleTxn);
    return { ok: true, balanceCents: Number(bal), saleTxn, alreadyCredited: false };
  } catch (ce) {
    const msg = String((ce as Error).message ?? "");
    // wallet_credit's replay check is NOT taken under the row lock (128_usage_wallet.sql),
    // so two concurrent identical credits both miss it and the loser hits the unique index.
    // That is success, not failure: the money is in the wallet exactly once.
    if (/duplicate key|unique constraint|23505/i.test(msg)) {
      await closeAttempt("closed_ok", "credit already posted (idempotent replay)", saleTxn);
      const { data: acct } = await admin.from("wallet_accounts").select("balance_cents").eq("client_id", clientId).maybeSingle();
      return { ok: true, balanceCents: Number(acct?.balance_cents ?? 0), saleTxn, alreadyCredited: true };
    }
    // MONEY MOVED, BALANCE DIDN'T. The worst state this function can reach, and it must be
    // loud. No auto-refund: the sale is probably fine and only the ledger write was flaky —
    // reversing a good charge on a guess is its own incident. Support reconciles from the
    // sale txn on the attempt row.
    await closeAttempt("closed_unknown", `sale ${saleTxn} succeeded but wallet_credit failed: ${msg}`, saleTxn);
    await admin.from("app_errors").insert({
      source: "edge:wallet-topup", severity: "error", code: "wallet_topup_credit_failed",
      message: `${clientId}: CARD CHARGED ${amountCents} cents (txn ${saleTxn}) but the wallet was NOT credited: ${msg}. Credit it by hand (admin-catalog wallet_adjust) and close the attempt row.`,
      client_id: clientId,
    }).then(() => undefined, () => undefined);
    return {
      ok: false,
      error: "Your card was charged but the balance did not update. CSM Synergy has been notified and will put it right - do NOT try again.",
      blocking: true,
    };
  }
}

// ── Auto-recharge eligibility ────────────────────────────────────────────────────────────
// Pure, so it can be unit tested without a database or a gateway. Every reason to decline is
// named rather than collapsed into a boolean: at debit time this runs inside a fail-soft
// block, and "why didn't my wallet recharge?" needs an answer.
export const AUTO_TOPUP_COOLDOWN_MS = 60 * 60 * 1000;

export type AutoTopupAccount = {
  auto_topup_enabled?: boolean | null;
  auto_topup_threshold_cents?: number | null;
  auto_topup_amount_cents?: number | null;
  auto_topup_last_at?: string | null;
  balance_cents?: number | null;
  held_cents?: number | null;
};

export function autoTopupDecision(
  acct: AutoTopupAccount | null | undefined,
  hasVault: boolean,
  now: number,
): { fire: false; reason: string } | { fire: true; amountCents: number } {
  if (!acct) return { fire: false, reason: "no wallet account" };
  if (!acct.auto_topup_enabled) return { fire: false, reason: "not enabled" };
  if (!hasVault) return { fire: false, reason: "no card on file" };

  const threshold = Number(acct.auto_topup_threshold_cents) || 0;
  const amount = Number(acct.auto_topup_amount_cents) || 0;
  if (threshold < MIN_TOPUP_CENTS) return { fire: false, reason: "threshold not configured" };
  if (amount < MIN_TOPUP_CENTS || amount > MAX_TOPUP_CENTS) return { fire: false, reason: "amount not configured" };

  // AVAILABLE, not balance: money already held for an in-flight generation is spent as far as
  // the next one is concerned. Recharging on balance alone would let a tenant sit at zero
  // available while the trigger says they are fine.
  const available = (Number(acct.balance_cents) || 0) - (Number(acct.held_cents) || 0);
  if (available >= threshold) return { fire: false, reason: "above threshold" };

  // COOLDOWN. A burst of generations crosses the threshold repeatedly within seconds; without
  // this, each one charges the card again.
  const last = acct.auto_topup_last_at ? Date.parse(acct.auto_topup_last_at) : NaN;
  if (Number.isFinite(last) && now - last < AUTO_TOPUP_COOLDOWN_MS) {
    return { fire: false, reason: "cooling down" };
  }
  return { fire: true, amountCents: amount };
}
