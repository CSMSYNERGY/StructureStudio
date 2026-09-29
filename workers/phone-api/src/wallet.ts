// The wallet floor (plan section 17): before an OUTBOUND call, refuse when the builder's
// wallet is below a floor. Inbound calls and 911 never come through here.
//
// ARMED ONLY WITH THE METER. The floor applies only while usage_prices `voice_minute` is
// active AND priced above zero, the same arming rail the daily minute debit reads. With the
// meter disarmed (how migration 254 seeds it) no call is ever refused for money.
//
// Exempt tenants are never refused, for the reason they are never charged (taxMeter.ts steps
// 2 and 2b): wallet_accounts.metered_exempt, or client_settings.billing_exempt.
//
// The balance compared is what can be spent: balance_cents minus held_cents (an open hold is
// money already promised to another meter). No wallet row means a balance of zero.
//
// Any read failing FAILS OPEN (reason "error"): a billing hiccup must not stop a builder
// calling a customer. The caller logs it.

import { type Admin } from "./db";

export const VOICE_METER = "voice_minute";

export type WalletVerdict =
  | { refuse: true; reason: "below_floor"; availableCents: number; floorCents: number }
  | { refuse: false; reason: "disarmed" | "exempt" | "above_floor" | "error"; availableCents?: number; floorCents?: number };

export async function walletFloorCheck(admin: Admin, clientId: string, floorCents: number): Promise<WalletVerdict> {
  try {
    const [price, acct, cs] = await Promise.all([
      admin.from("usage_prices").select("price_cents, active").eq("kind", VOICE_METER).maybeSingle(),
      admin.from("wallet_accounts").select("balance_cents, held_cents, metered_exempt").eq("client_id", clientId).maybeSingle(),
      admin.from("client_settings").select("billing_exempt").eq("client_id", clientId).maybeSingle(),
    ]);
    if (price.error) return { refuse: false, reason: "error" };
    const p = price.data as { price_cents?: number; active?: boolean } | null;
    if (!p || p.active !== true || !(Number(p.price_cents) > 0)) return { refuse: false, reason: "disarmed" };
    if (acct.error || cs.error) return { refuse: false, reason: "error" };
    const a = acct.data as { balance_cents?: number | string; held_cents?: number | string; metered_exempt?: boolean } | null;
    if (a?.metered_exempt === true || (cs.data as { billing_exempt?: boolean } | null)?.billing_exempt === true) {
      return { refuse: false, reason: "exempt" };
    }
    // bigint columns can arrive as strings; Number() takes both.
    const availableCents = (Number(a?.balance_cents ?? 0) || 0) - (Number(a?.held_cents ?? 0) || 0);
    if (availableCents < floorCents) return { refuse: true, reason: "below_floor", availableCents, floorCents };
    return { refuse: false, reason: "above_floor", availableCents, floorCents };
  } catch {
    return { refuse: false, reason: "error" };
  }
}
