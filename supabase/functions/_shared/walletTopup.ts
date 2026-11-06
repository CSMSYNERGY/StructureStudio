// _shared/walletTopup.ts — put real money into the prepaid wallet, exactly once.
//
// ONE implementation, two callers that must never diverge:
//   portal-billing  `topup`        — a builder (or an operator) pressing Add funds
//   portal-settings  auto-recharge — unattended, when a 3D hold drops them under threshold
//
// Both move the same money through the same gateway into the same ledger, so they are the
// same function. Two things differ: `auto`, which changes the memo, and `cof`, which tells the
// card networks who started the charge (below). Neither changes the mechanics.
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

//
// STORED CREDENTIALS (migration 317). Every top-up says what it is to the card networks, through
// _shared/nmi.ts cofFields. The caller decides which, because only it knows who pressed what:
//   cit_initial_unscheduled  the builder's FIRST top-up: a new card (stored by this very sale,
//                            customer_vault=add_customer, so a decline stores nothing) or the first
//                            time a card saved by a subscription pays for a top-up. Its approved
//                            sale becomes the vault's unscheduled initial (billing_customers).
//   cit_used                 a later top-up the builder asked for (themselves, or an operator on
//                            the phone with them).
//   mit_unscheduled          an automatic top-up, or an operator top-up the builder did not ask
//                            for. Must name the vault's unscheduled initial; cofFields refuses
//                            to build one without it, and this function then charges nothing.

import { nmiPostCof, isGatewayUnknown, cofFields, NmiDeclined, type CofKind } from "./nmi.ts";
import { AUTO_TOPUP_DAILY_MAX, stampConsent } from "./cofConsent.ts";

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
  | {
    ok: true; balanceCents: number; saleTxn: string | null; alreadyCredited: boolean;
    /** The attempt row (receipts are recorded on it) and the vault the sale ran on. */
    attemptId: string | number; vaultId: string | null; cofSupported: string | null;
  }
  | {
    ok: false; error: string; blocking: boolean;
    /** Set only when the CARD WAS CHARGED but the wallet could not be credited: the sale, and
     *  the attempt row. A merchant-initiated top-up still owes its owner a receipt then. */
    chargedTxn?: string | null; attemptId?: string | number;
  };

export type TopupCof = Extract<CofKind, "cit_initial_unscheduled" | "cit_used" | "mit_unscheduled">;

/** A card being entered right now: stored by the sale itself, so a decline stores nothing. */
export type TopupNewCard = { paymentToken: string; firstName?: string; lastName?: string; email?: string };

// deno-lint-ignore no-explicit-any
type Admin = any;

/**
 * Charge `amountCents` to the tenant's card and credit the wallet.
 * Never throws: every outcome is a TopupResult the caller can render or log.
 * `blocking: true` means DO NOT retry automatically — a human has to look.
 *
 * The card is EITHER `vaultId` (already stored) OR `newCard` (stored by this sale), never both.
 * `newCard` is only ever a cardholder's first top-up, so it must come with cit_initial_unscheduled.
 */
export async function chargeTopup(admin: Admin, opts: {
  clientId: string;
  vaultId?: string | null;
  newCard?: TopupNewCard | null;
  amountCents: number;
  actorUserId?: string | null;
  auto: boolean;
  cof: TopupCof;
  /** The vault's unscheduled initial: required for mit_unscheduled, sent with cit_used when known. */
  initialTxn?: string | null;
  /** Shown as "ending 1234" later; recorded with the card when this sale stores or first uses it. */
  card?: { last4: string | null; brand: string | null } | null;
  /** The billing_consents row this charge was agreed under; stamped with the sale on approval. */
  consentId?: number | null;
}): Promise<TopupResult> {
  const { clientId, amountCents, auto, cof } = opts;
  const vaultId = String(opts.vaultId ?? "").trim() || null;
  const newCard = opts.newCard && String(opts.newCard.paymentToken ?? "").trim() ? opts.newCard : null;
  const actor = opts.actorUserId ?? null;

  if (!Number.isInteger(amountCents) || amountCents < MIN_TOPUP_CENTS || amountCents > MAX_TOPUP_CENTS) {
    return { ok: false, error: "That top-up amount isn't allowed.", blocking: false };
  }
  if (!vaultId && !newCard) return { ok: false, error: "No card on file.", blocking: false };
  if (vaultId && newCard) return { ok: false, error: "A card is already on file.", blocking: false };
  if (newCard && cof !== "cit_initial_unscheduled") {
    return { ok: false, error: "A new card can only be stored by its owner's own first top-up.", blocking: false };
  }
  // Built BEFORE anything is recorded: an MIT with no initial throws here, and the right outcome
  // of that is nothing at all, not an attempt row and a refused sale.
  try {
    cofFields(cof, { initialTxn: opts.initialTxn });
  } catch (e) {
    return { ok: false, error: (e as Error).message, blocking: false };
  }

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

  // 3. Insert 'open' — also the concurrency guard, via the partial unique index. The orderid
  //    written here is a placeholder: the real one is minted from the row's own id, which does
  //    not exist until the insert returns. Do NOT reach for a pre-read to get an id first —
  //    this insert IS the guard, and reading before writing reopens the double-charge window.
  const { data: attempt, error: attErr } = await admin.from("billing_charge_attempts")
    .insert({ client_id: clientId, plan_id: TOPUP_PLAN_ID, orderid: `ss_topup_${clientId}_${Date.now()}`, cof })
    .select("id").maybeSingle();
  if (attErr || !attempt) {
    return { ok: false, error: "Another top-up is already in progress. Give it a moment, then refresh.", blocking: false };
  }

  // THE ORDER ID IS THE RECONCILIATION KEY. When a top-up ends unverifiable, support looks the
  // charge up AT THE GATEWAY by the string on the attempt row — so the row has to carry the
  // string the gateway was actually given, not the placeholder minted a moment before the row
  // had an id. One value, used for the sale below and written back here.
  //
  // Fire-and-forget on purpose: a failed write-back leaves the placeholder, which is still
  // findable by tenant and timestamp, whereas throwing here would abandon an 'open' row and
  // block every later top-up for that tenant. Never let bookkeeping abort the sale.
  const orderid = `ss_topup_${clientId}_${attempt.id}`;
  await admin.from("billing_charge_attempts")
    .update({ orderid }).eq("id", attempt.id)
    .then(() => undefined, () => undefined);

  let cofSupported: string | null = null;
  const closeAttempt = (state: string, detail: string | null, txn: string | null) =>
    admin.from("billing_charge_attempts")
      .update({ state, detail, sale_txn: txn, cof_supported: cofSupported, closed_at: new Date().toISOString() })
      .eq("id", attempt.id).then(() => undefined, () => undefined);

  // 4. The sale. A new card rides on it (customer_vault=add_customer): NMI stores the card only
  //    "if the transaction is successful", so a declined first top-up leaves nothing on file.
  let saleTxn: string | null = null;
  let chargedVault: string | null = vaultId;
  try {
    const { res, cofSupported: cs } = await nmiPostCof({
      type: "sale",
      amount: (amountCents / 100).toFixed(2),
      ...(newCard
        ? {
          customer_vault: "add_customer",
          payment_token: String(newCard.paymentToken).trim(),
          first_name: String(newCard.firstName ?? ""),
          last_name: String(newCard.lastName ?? ""),
          email: String(newCard.email ?? ""),
        }
        : { customer_vault_id: vaultId as string }),
      orderid,
      merchant_defined_field_1: clientId,
      order_description: `StructureStudio wallet top-up${auto ? " (automatic)" : ""}`,
    }, cof, { initialTxn: opts.initialTxn });
    saleTxn = res.transactionid || null;
    cofSupported = cs;
    if (newCard) chargedVault = res.customer_vault_id || null;
  } catch (se) {
    if (isGatewayUnknown(se)) {
      // The card MAY have been charged and we cannot know. Do not credit, do not retry.
      await closeAttempt("closed_unknown", `top-up sale unverifiable: ${(se as Error).message}`, null);
      await admin.from("app_errors").insert({
        source: "edge:wallet-topup", severity: "error", code: "wallet_topup_unknown",
        message: `${clientId}: ${amountCents} cent top-up outcome unverifiable - look it up at the gateway by orderid ${orderid} (attempt ${attempt.id}) before allowing another.${newCard ? ` This sale also stored a NEW card (customer_vault=add_customer): if a customer vault was created (merchant_defined_field_1 = ${clientId}), record it on billing_customers with this sale as unscheduled_initial_txn, or delete it.` : ""} ${(se as Error).message}`,
        client_id: clientId,
      }).then(() => undefined, () => undefined);
      return {
        ok: false,
        error: "We could not confirm whether your card was charged. Do NOT try again - contact CSM Synergy and we will confirm and finish the top-up.",
        blocking: true,
      };
    }
    // A plain decline: the gateway answered, nothing was charged. Safe to say so.
    if (se instanceof NmiDeclined) cofSupported = se.fields.cof_supported ?? null;
    await closeAttempt("closed_declined", (se as Error).message, null);
    return { ok: false, error: (se as Error).message, blocking: false };
  }

  // 4b. THE CARD AND ITS UNSCHEDULED INITIAL. Only for the builder's first top-up: this approved
  //     sale is what every later automatic top-up names as initial_transaction_id. Recorded before
  //     the credit because a new card's vault id exists nowhere else but this response.
  //     Bookkeeping only from here on: a failed write is filed loudly and the sale stands.
  await stampConsent(admin, opts.consentId ?? null, saleTxn);
  if (cof === "cit_initial_unscheduled") {
    const now = new Date().toISOString();
    const last4 = opts.card?.last4 && /^\d{4}$/.test(opts.card.last4) ? opts.card.last4 : null;
    const brand = opts.card?.brand ?? null;
    // A stored card keeps the details it has unless this request knows better.
    const cardCols = newCard
      ? { card_last4: last4, card_brand: brand, card_saved_at: now }
      : last4 ? { card_last4: last4, card_brand: brand } : {};
    let recErr: string | null = null;
    if (!chargedVault) {
      recErr = "the gateway charged the card but returned no customer_vault_id";
    } else if (!saleTxn) {
      recErr = "the gateway approved the sale but returned no transactionid";
    } else {
      const { error } = await admin.from("billing_customers").upsert({
        client_id: clientId,
        vault_id: chargedVault,
        unscheduled_initial_txn: saleTxn,
        unscheduled_initial_at: now,
        updated_at: now,
        ...cardCols,
      }, { onConflict: "client_id" }).then((r: { error: unknown }) => r, (e: unknown) => ({ error: e }));
      if (error) recErr = String((error as Error)?.message ?? error);
    }
    if (recErr) {
      await admin.from("app_errors").insert({
        source: "edge:wallet-topup", severity: "error", code: "wallet_topup_initial_unrecorded",
        message: `${clientId}: first top-up ${saleTxn ?? "(no txn)"} (orderid ${orderid}, vault ${chargedVault ?? "unknown"}) was charged but could not be recorded as the card's unscheduled initial: ${recErr}. Until it is, automatic top-ups stay refused; set billing_customers.unscheduled_initial_txn by hand.`,
        client_id: clientId,
      }).then(() => undefined, () => undefined);
    }
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
    return { ok: true, balanceCents: Number(bal), saleTxn, alreadyCredited: false, attemptId: attempt.id, vaultId: chargedVault, cofSupported };
  } catch (ce) {
    const msg = String((ce as Error).message ?? "");
    // wallet_credit's replay check is NOT taken under the row lock (128_usage_wallet.sql),
    // so two concurrent identical credits both miss it and the loser hits the unique index.
    // That is success, not failure: the money is in the wallet exactly once.
    if (/duplicate key|unique constraint|23505/i.test(msg)) {
      await closeAttempt("closed_ok", "credit already posted (idempotent replay)", saleTxn);
      const { data: acct } = await admin.from("wallet_accounts").select("balance_cents").eq("client_id", clientId).maybeSingle();
      return { ok: true, balanceCents: Number(acct?.balance_cents ?? 0), saleTxn, alreadyCredited: true, attemptId: attempt.id, vaultId: chargedVault, cofSupported };
    }
    // MONEY MOVED, BALANCE DIDN'T. The worst state this function can reach, and it must be
    // loud. No auto-refund: the sale is probably fine and only the ledger write was flaky —
    // reversing a good charge on a guess is its own incident. Support reconciles from the
    // sale txn on the attempt row.
    await closeAttempt("closed_unknown", `sale ${saleTxn} succeeded but wallet_credit failed: ${msg}`, saleTxn);
    await admin.from("app_errors").insert({
      source: "edge:wallet-topup", severity: "error", code: "wallet_topup_credit_failed",
      message: `${clientId}: CARD CHARGED ${amountCents} cents (txn ${saleTxn}, orderid ${orderid}, attempt ${attempt.id}) but the wallet was NOT credited: ${msg}. Credit it by hand (admin-catalog wallet_adjust) and close the attempt row.`,
      client_id: clientId,
    }).then(() => undefined, () => undefined);
    return {
      ok: false,
      error: "Your card was charged but the balance did not update. CSM Synergy has been notified and will put it right - do NOT try again.",
      blocking: true,
      chargedTxn: saleTxn,
      attemptId: attempt.id,
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
  /** Automatic top-up attempts in the last 24 hours (walletAutoTopup.ts counts them). */
  autoChargesLast24h = 0,
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
  // DAILY CAP (317), the number the builder agreed to in the auto top-up sentence. The cooldown
  // alone allows 24 a day; this is the backstop for a wallet draining faster than anyone meant.
  if ((Number(autoChargesLast24h) || 0) >= AUTO_TOPUP_DAILY_MAX) {
    return { fire: false, reason: "daily limit reached" };
  }
  return { fire: true, amountCents: amount };
}
