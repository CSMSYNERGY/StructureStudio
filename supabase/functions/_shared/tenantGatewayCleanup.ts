// What deleting a builder does at the payment gateway: cancel their subscriptions, then remove their
// saved card from the gateway's customer vault (2026-10-05).
//
// WHY THIS EXISTS. admin-catalog's delete_client wiped billing_subscriptions and billing_customers,
// which are only our MIRRORS of gateway state. The subscriptions themselves kept charging the
// builder's card at Deposyt/NMI and the card stayed in the gateway's vault, with no local row left to
// show either existed. Carolyn, 07-31: card information is not kept for a builder who is gone.
//
// ⚠️ THE GATEWAY ACCOUNT IS SHARED with other CSM Synergy products (Framed-UP among them), and both
// calls below are irreversible. So this module never looks an id up, never lists, never guesses: it
// acts only on the ids its caller read from the deleted tenant's own rows. And it fails CLOSED. Any
// answer short of "done" or "that id no longer exists" throws, and the caller refuses the delete with
// nothing wiped, because a wiped tenant with a live subscription is a builder still being charged
// with nothing on our side to show why.
//
// ⛔ The vault id is a bearer capability for charging that card. It goes to the gateway and nowhere
// else: the result is counts, and every thrown message has it scrubbed out, even if a gateway
// sentence ever echoes it back.
//
// Pure apart from the injected gateway client, so tenantGatewayCleanup.test.ts drives it with a fake
// one. It imports nmi.ts only for isGatewayUnknown: two definitions of "we don't know what happened"
// on a money path is the one thing nmi.ts exists to prevent.

import { isGatewayUnknown } from "./nmi.ts";

export type NmiPost = (params: Record<string, string>) => Promise<Record<string, string>>;

export interface TenantSubscription {
  id: string;
  status: string | null;
}

export interface GatewayCleanup {
  /** This tenant's open subscriptions that are no longer at the gateway: cancelled now, or found
   *  already gone. */
  subscriptionsCancelled: number;
  /** The saved card is no longer in the gateway's vault: removed now, or found already gone. False
   *  only when there was no vault id to act on. */
  vaultDeleted: boolean;
  /** How many of the above the gateway answered "unknown id" for, rather than deleting now. */
  alreadyGone: number;
}

/** Thrown when the gateway did not confirm a step. `progress` is what HAD happened at the gateway
 *  before it stopped (irreversible, so the caller must report it), and `unknown` is true when the
 *  gateway never answered at all, so the step itself may or may not have gone through. `said` is
 *  the gateway's own sentence, vault id scrubbed, for the operator to read. */
export class GatewayCleanupError extends Error {
  constructor(
    readonly step: "delete_subscription" | "delete_customer",
    readonly said: string,
    readonly unknown: boolean,
    readonly progress: GatewayCleanup,
  ) {
    super(`${step}: ${said}`);
    this.name = "GatewayCleanupError";
  }
}

// "That id does not exist here", per object. Each pattern is anchored on its OWN object's name, so a
// subscription delete is never satisfied by a sentence about the vault, or the reverse.
//
// ⚠️ PROVENANCE, because these decide whether a delete proceeds:
//   - vault: "Invalid Customer Vault Id Specified REFID:<n>" (response_code 300 / 220) is NMI's
//     documented answer for a vault id it does not hold.
//   - subscription: NMI's sentence for an unknown subscription id is NOT confirmed. It could not be
//     probed on 2026-10-05: NMI's public demo account no longer answers ("Specified API key not
//     found" for the published test key, "Authentication Failed" for the demo login), and the
//     production account is shared with Framed-UP, so it is never used for probing. The pattern
//     is narrow on purpose, and anything it misses refuses the delete with the gateway's own
//     sentence in the message. That is the visible, safe failure. Widen it from that sentence.
//   - NEGATIVES, all real: "Specified API key not found" (a wrong key, so it says "not found" but
//     about the key), "Authentication Failed", "Duplicate transaction", and "Your account is not set
//     up to use the Customer Vault". None of them may ever read as gone.
// The object must be named as an ID ("Invalid subscription amount" is about something else), and
// the only word allowed between it and the verdict is an id-like token with a digit in it ("Customer
// Vault Id 123 not found"), so "Subscription plan not found" cannot read as gone either.
const ID_TOKEN = String.raw`(?:\s*[#:=]?\s*[\w-]*\d[\w-]*)?`;
const VERDICT = String.raw`\s+(?:was\s+|is\s+)?`;
const GONE: Record<"subscription" | "vault", RegExp> = {
  subscription: new RegExp(
    String.raw`\b(?:invalid|unknown)\s+subscription[\s_]?id\b` +
      String.raw`|\bsubscription(?:[\s_]?id)?${ID_TOKEN}${VERDICT}(?:not found|does not exist|no longer exists|already (?:been )?(?:deleted|cancell?ed)|(?:has been|been) (?:deleted|cancell?ed))\b` +
      String.raw`|\bno (?:such )?subscription(?:[\s_]?id)?\s+(?:found|exists)\b|\bno such subscription\b`,
    "i",
  ),
  vault: new RegExp(
    String.raw`\b(?:invalid|unknown)\s+customer[\s_]vault[\s_]?id\b` +
      String.raw`|\bcustomer[\s_]vault[\s_]?id${ID_TOKEN}${VERDICT}(?:not found|does not exist|no longer exists)\b`,
    "i",
  ),
};

/** Whether a gateway decline means "the id you asked about does not exist". Never true for a
 *  GATEWAY_UNKNOWN: no answer is not an answer, whatever its text happens to say. */
export function gatewaySaysGone(kind: "subscription" | "vault", e: unknown): boolean {
  if (isGatewayUnknown(e)) return false;
  return GONE[kind].test(String((e as Error)?.message ?? e ?? ""));
}

/** The subscriptions that still need cancelling. A 'cancelled' row was already deleted at the gateway
 *  (portal-billing and the upgrade path call delete_subscription BEFORE they mark it), and every
 *  other status, an unmapped or missing one included, is treated as open: when unsure, cancel. */
export function openSubscriptions(subs: readonly TenantSubscription[] | null | undefined): TenantSubscription[] {
  return (subs ?? []).filter((s) => s && String(s.id ?? "").trim() !== "" && s.status !== "cancelled");
}

/** Whether a delete has anything to do at the gateway. The caller asks this BEFORE it checks the
 *  gateway is configured: a tenant with nothing there must stay deletable without it. */
export function needsGateway(subs: readonly TenantSubscription[] | null | undefined, vaultId: string | null | undefined): boolean {
  return openSubscriptions(subs).length > 0 || String(vaultId ?? "").trim() !== "";
}

/**
 * Subscriptions first, then the vault. The other order would leave live subscriptions pointing at
 * a card the gateway no longer holds: no charge, but a recurring decline on every billing date for
 * a builder who no longer exists.
 *
 * `onCancelled` runs after each subscription is gone, so the caller can mark its mirror row
 * cancelled at once. Then a delete that stops part-way and is retried skips what already went,
 * instead of relying on the gateway's "unknown id" sentence. Its failure is swallowed: the gateway
 * step happened either way, and the gateway's own delete event will correct the row.
 *
 * `onVaultDeleted` is the same thing for the saved card: it runs once the vault is gone (removed
 * now, or found already gone), so the caller can drop the row holding the vault id before anything
 * else can fail. A retry then has no vault id to send, and a tenant that survives a failed delete
 * shows no card on file that the gateway no longer holds. Its failure is swallowed too, for the
 * same reason: the caller's own wipe of that row is the backstop.
 */
export async function cleanupTenantGateway(opts: {
  subs: readonly TenantSubscription[] | null | undefined;
  vaultId: string | null | undefined;
  nmiPost: NmiPost;
  onCancelled?: (subscriptionId: string) => unknown;
  onVaultDeleted?: () => unknown;
}): Promise<GatewayCleanup> {
  const vault = String(opts.vaultId ?? "").trim();
  const progress: GatewayCleanup = { subscriptionsCancelled: 0, vaultDeleted: false, alreadyGone: 0 };
  const scrub = (msg: string) => (vault ? msg.split(vault).join("[saved card]") : msg);
  const refuse = (step: GatewayCleanupError["step"], e: unknown): GatewayCleanupError => {
    const said = scrub(String((e as Error)?.message ?? e ?? "").trim()) || "no reason given";
    return new GatewayCleanupError(step, said, isGatewayUnknown(e), { ...progress });
  };

  for (const s of openSubscriptions(opts.subs)) {
    const id = String(s.id).trim();
    try {
      await opts.nmiPost({ recurring: "delete_subscription", subscription_id: id });
    } catch (e) {
      if (!gatewaySaysGone("subscription", e)) throw refuse("delete_subscription", e);
      progress.alreadyGone++;
    }
    progress.subscriptionsCancelled++;
    if (opts.onCancelled) {
      try { await opts.onCancelled(id); } catch (_e) { /* the gateway step happened; see above */ }
    }
  }

  if (vault) {
    try {
      await opts.nmiPost({ customer_vault: "delete_customer", customer_vault_id: vault });
    } catch (e) {
      if (!gatewaySaysGone("vault", e)) throw refuse("delete_customer", e);
      progress.alreadyGone++;
    }
    progress.vaultDeleted = true;
    if (opts.onVaultDeleted) {
      try { await opts.onVaultDeleted(); } catch (_e) { /* the card is gone either way; see above */ }
    }
  }

  return progress;
}
