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
// ⚠️ Duplication ledger — this module is the original now. Importers:
//   portal-billing/index.ts   (subscribe, cancel, topup)
//   _shared/walletTopup.ts    (the shared top-up charge, used by both portal functions)

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
    throw new Error(parsed.responsetext || "transaction declined");
  }
  return parsed as Record<string, string>;
}
