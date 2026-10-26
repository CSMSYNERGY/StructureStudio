// _shared/nmi.ts — the Deposyt/NMI Payment API client, and the ONE definition of what
// "we don't know what happened" means on a money path.
//
// Extracted VERBATIM from portal-billing/index.ts on 2026-08-29 (migration 164, wallet
// top-ups). It moved for exactly one reason: portal-settings now has to charge a card too —
// auto-recharge fires when a 3D generation drops the wallet below its threshold — and a
// second copy of this file is the last thing this codebase should have. Two gateway clients
// means two definitions of `isGatewayUnknown`, and the day they disagree is the day a
// customer gets charged twice.
//
// Behaviour is unchanged from the original. If you are diffing against portal-billing's
// history: same 30s timeout, same >=500 → unknown, same response!=="1" → throw responsetext.
//
// Since migration 317 every sale or validate on a stored card goes through nmiPostCof (below),
// which adds the Visa/Mastercard stored-credential fields; a plain nmiPost is for reversals,
// subscription registration and removal only (pinned by _test_stubs/cofCharges_test.ts).
//
// ⚠️ Duplication ledger — this module is the original now. Importers:
//   portal-billing/index.ts   (subscribe, cancel, topup)
//   _shared/walletTopup.ts    (the shared top-up charge, used by both portal functions)
//   admin-catalog/index.ts    (delete_client: cancel the tenant's subscriptions, delete its vault)
//   _shared/tenantGatewayCleanup.ts (isGatewayUnknown only; admin-catalog hands it nmiPost)

export const GATEWAY = (Deno.env.get("NMI_GATEWAY_URL") || "https://deposyt.transactiongateway.com").replace(/\/+$/, "");
const SECURITY_KEY = Deno.env.get("NMI_SECURITY_KEY") || "";
export const TOKENIZATION_KEY = Deno.env.get("NMI_TOKENIZATION_KEY") || "";

// Whether this deployment can move money at all. Both keys or nothing: a tokenization key
// without a security key mints tokens nobody can charge, and a security key without a
// tokenization key cannot collect a card in the first place.
export const nmiConfigured = Boolean(SECURITY_KEY && TOKENIZATION_KEY);

// POST to the gateway's Payment API. Form-urlencoded in/out; response=1 approved.
//
// TWO distinct failure kinds, and money-path callers must not conflate them:
//   - a DECLINE: the gateway answered and said no. The outcome is KNOWN — nothing charged.
//   - TRANSPORT failure (timeout, reset, 5xx before a parseable body): the outcome is
//     UNKNOWN. The gateway may have processed the request — including charging the card —
//     and we simply never heard. Callers must treat this as "possibly happened", never as
//     "didn't happen"; treating it as a decline is how a customer gets charged twice.
// isGatewayUnknown() tells them apart. The 30s timeout turns an indefinite hang into an
// explicit unknown instead of letting the whole function die mid-loop with no catch.
const GATEWAY_UNKNOWN = "GATEWAY_UNKNOWN:";
export function isGatewayUnknown(e: unknown): boolean {
  return String((e as Error)?.message ?? "").startsWith(GATEWAY_UNKNOWN);
}

/**
 * The gateway ANSWERED and said no. Still an Error whose message is the gateway's responsetext,
 * exactly as before, so every existing `(e as Error).message` keeps reading the same sentence; the
 * fields are for the one caller that has to tell a refused FIELD from a refused CARD (see
 * nmiPostCof: response "3" is "error in transaction data", "2" is a decline).
 */
export class NmiDeclined extends Error {
  readonly response: string;
  readonly responseCode: string;
  readonly fields: Record<string, string>;
  constructor(fields: Record<string, string>) {
    super(fields.responsetext || "transaction declined");
    this.name = "NmiDeclined";
    this.response = fields.response ?? "";
    this.responseCode = fields.response_code ?? "";
    this.fields = fields;
  }
}

export async function nmiPost(params: Record<string, string>) {
  const body = new URLSearchParams({ security_key: SECURITY_KEY, ...params });
  let text: string;
  try {
    const res = await fetch(`${GATEWAY}/api/transact.php`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(30000),
    });
    if (res.status >= 500) throw new Error(`${GATEWAY_UNKNOWN} gateway returned HTTP ${res.status}`);
    text = await res.text();
  } catch (e) {
    if (isGatewayUnknown(e)) throw e;
    throw new Error(`${GATEWAY_UNKNOWN} ${(e as Error).message}`);
  }
  const parsed = Object.fromEntries(new URLSearchParams(text));
  if (parsed.response !== "1") {
    throw new NmiDeclined(parsed);
  }
  return parsed as Record<string, string>;
}

// ── STORED CREDENTIALS (Visa/Mastercard COF framework), migration 317 ─────────────────────
//
// Every sale on a card we keep says who started it and where it sits in an agreement. NMI's
// Payment API names, from its "Credential on File Information" section and variable table:
//
//   cit_initial_recurring   the first charge of a NEW subscription (one per subscription, even
//                           on a card already in the vault): customer + stored + billing_method
//   cit_initial_unscheduled the first top-up the builder makes themselves, or a replacement
//                           card's $0 check: customer + stored, NO billing_method
//   cit_used                a later top-up the builder asks for (or tells an operator to make on
//                           the phone): customer + used, + the unscheduled initial when we have it
//   mit_unscheduled         an automatic top-up, or an operator top-up the builder did not ask
//                           for: merchant + used + initial_transaction_id (REQUIRED). NMI's own
//                           example of an unscheduled MIT is "account auto-top up".
//
// Renewals are NOT here. NMI's Recurring module charges them and flags them itself; its
// add_subscription call takes no COF fields at all.
//
// The id named as initial_transaction_id for an unscheduled charge must be an UNSCHEDULED
// initial. NMI: a recurring series' id cannot be reused for unscheduled transactions, or the
// reverse, so a subscription's first sale is never the answer for a top-up.
export type CofKind = "cit_initial_recurring" | "cit_initial_unscheduled" | "cit_used" | "mit_unscheduled";

/** billing_method for a recurring initial. NMI's variable table says 'initial_recurring' (newer)
 *  and its CoF section's "MUST INCLUDE" example still says 'recurring' (older), with "which values
 *  apply depends on the processor". Both are documented for the initial.
 *
 *  NMI_INITIAL_RECURRING_METHOD forces one value everywhere ('recurring' once the processor behind
 *  Deposyt is known to refuse the newer one; 'initial_recurring' once Deposyt confirms it). Unset:
 *  'initial_recurring', with nmiPostCof's one fallback retry, EXCEPT on a request that carries a
 *  Collect.js payment_token. That token is single-use, so a retry could not reuse it, and a refusal
 *  there would leave a new builder unable to subscribe at all: such a request sends 'recurring'. */
export function initialRecurringMethod(opts: { carriesToken?: boolean } = {}): "initial_recurring" | "recurring" {
  const forced = (Deno.env.get("NMI_INITIAL_RECURRING_METHOD") ?? "").trim();
  if (forced === "recurring" || forced === "initial_recurring") return forced;
  return opts.carriesToken ? "recurring" : "initial_recurring";
}

/** A response=3 that refused a FIELD, before any authorization reached an issuer. NMI response
 *  codes: 300 rejected by the gateway, 440 processor format error, 441 invalid transaction
 *  information, 460 processor feature not available. Deliberately NOT 400 ("error returned by
 *  processor") or 420/421 (communication errors, the issuer may have answered): retrying those
 *  could put a second authorization in front of the issuer. */
const FIELD_REFUSAL_CODES = new Set(["300", "440", "441", "460"]);
export function isFieldRefusal(e: unknown): boolean {
  if (!(e instanceof NmiDeclined) || e.response !== "3") return false;
  return FIELD_REFUSAL_CODES.has(e.responseCode) || /billing[_ ]?method/i.test(e.message);
}

/** The COF fields for one sale/validate. Throws for an MIT without its initial: sending one
 *  unlinked is the exact defect this module exists to stop, so it cannot be done by accident. */
export function cofFields(
  kind: CofKind,
  opts: { initialTxn?: string | null; billingMethod?: "initial_recurring" | "recurring"; carriesToken?: boolean } = {},
): Record<string, string> {
  const initial = String(opts.initialTxn ?? "").trim();
  switch (kind) {
    case "cit_initial_recurring":
      return { initiated_by: "customer", stored_credential_indicator: "stored", billing_method: opts.billingMethod ?? initialRecurringMethod({ carriesToken: opts.carriesToken }) };
    case "cit_initial_unscheduled":
      return { initiated_by: "customer", stored_credential_indicator: "stored" };
    case "cit_used":
      return { initiated_by: "customer", stored_credential_indicator: "used", ...(initial ? { initial_transaction_id: initial } : {}) };
    case "mit_unscheduled":
      if (!initial) throw new Error("A merchant-initiated charge needs the card's unscheduled initial transaction.");
      return { initiated_by: "merchant", stored_credential_indicator: "used", initial_transaction_id: initial };
  }
}

/**
 * nmiPost with the COF fields for `kind` added. Same contract as nmiPost (an NmiDeclined for a
 * decline, a GATEWAY_UNKNOWN error for transport), plus what was actually accepted:
 *   billingMethod  the billing_method that went through (recurring initials only, else null)
 *   cofSupported   NMI's cof_supported answer, verbatim ('stored' = the processor honours them)
 *
 * THE ONE RETRY, and why it cannot charge twice: a recurring initial sent with 'initial_recurring'
 * that is refused as a FIELD (isFieldRefusal: response=3 with a code that means the request was
 * refused before any authorization; a card decline is response=2) is sent once more with
 * 'recurring', the value NMI's CoF section has always used. Never for a request carrying a
 * payment_token (initialRecurringMethod already sends 'recurring' there, and a single-use token
 * cannot be sent twice). Anything else, including a transport failure, is returned exactly as
 * nmiPost returns it. The fallback is reported (fellBack, refusedWith) so the caller can file it,
 * and a retry that ALSO fails carries the first refusal on the thrown error (refusedWith), so the
 * warning is filed either way: once it is seen, NMI_INITIAL_RECURRING_METHOD=recurring stops
 * paying for a refused request on every checkout.
 */
export async function nmiPostCof(
  params: Record<string, string>,
  kind: CofKind,
  opts: { initialTxn?: string | null; post?: typeof nmiPost } = {},
): Promise<{ res: Record<string, string>; billingMethod: string | null; cofSupported: string | null; fellBack: boolean; refusedWith: string | null }> {
  const post = opts.post ?? nmiPost;
  const carriesToken = Boolean(String(params.payment_token ?? "").trim());
  const first = cofFields(kind, { initialTxn: opts.initialTxn, carriesToken });
  const done = (res: Record<string, string>, f: Record<string, string>, fellBack: boolean, refusedWith: string | null) => ({
    res, billingMethod: f.billing_method ?? null, cofSupported: res.cof_supported ?? null, fellBack, refusedWith,
  });
  try {
    return done(await post({ ...params, ...first }), first, false, null);
  } catch (e) {
    if (!(kind === "cit_initial_recurring" && first.billing_method === "initial_recurring" && !carriesToken && isFieldRefusal(e))) throw e;
    const second = cofFields(kind, { billingMethod: "recurring" });
    const why = `${(e as NmiDeclined).responseCode || "3"}: ${(e as Error).message}`.slice(0, 200);
    try {
      return done(await post({ ...params, ...second }), second, true, why);
    } catch (e2) {
      // The retry failed too. Keep the first refusal on what is thrown, so it is not lost, but
      // only when the retry failed DIFFERENTLY: the same refusal twice shows billing_method was
      // never the cause (a code 300 is also NMI's generic "rejected by gateway"), and blaming it
      // would send ops to the wrong setting.
      const same = e2 instanceof NmiDeclined && e2.response === (e as NmiDeclined).response &&
        e2.responseCode === (e as NmiDeclined).responseCode && e2.message === (e as Error).message;
      if (!same) (e2 as { refusedWith?: string }).refusedWith = why;
      throw e2;
    }
  }
}
