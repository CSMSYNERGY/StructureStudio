// The wallet floor (plan section 17, then Part 1 of the usage-billing plan, migration 259):
// before an OUTBOUND call, refuse when the builder's wallet is below the floor. Inbound calls
// and 911 never come through here.
//
// ONE ANSWER, FROM THE DATABASE. The verdict is public.wallet_usage_gate(client, meter), the
// same function the edge's texting path asks (_shared/usageGate.ts), so a call and a text
// cannot disagree about what "armed", "exempt" or "below the floor" means:
//   armed     phone_billing_settings has a markup AND armed_at, and the meter is active in
//             usage_prices (or the tenant is on the pilot list);
//   exempt    wallet_accounts.metered_exempt or client_settings.billing_exempt (taxMeter.ts
//             steps 2 and 2b): never refused, for the reason they are never charged;
//   available balance_cents - held_cents - the sub-cent remainder rounded up (an open hold is
//             money already promised to another meter); no wallet row is a balance of zero;
//   floor     phone_billing_settings.floor_cents (default 500). It used to be the Worker var
//             WALLET_FLOOR_CENTS; it moved so calls and texts share one number.
//
// THE ENV RAIL comes first: with PHONE_USAGE_METERS anything but exactly "on" the database is
// not even asked, and nothing is ever refused for money (how this ships).
//
// Any failure FAILS OPEN (reason "error"): a billing hiccup must not stop a builder calling a
// customer, and the call is still charged afterwards by cron/usageCharge.ts. The caller logs it.
//
// AUTO TOP-UP. A refused tenant with auto top-up switched on is not a dead end: the caller
// fires requestAutoTopup (waitUntil, never awaited by the call) and tells them to try again in
// a minute. The wallet-autotopup edge function holds the card secrets and decides for itself
// (threshold, cooldown, card on file), so asking twice is harmless.

import type { Env } from "./env";
import { type Admin } from "./db";
import { logFault } from "./log";

export const VOICE_METER = "voice_minute";

/** Spoken by /voice/outbound and sent by /sms/send. Plain words, the same in both places. */
export const WALLET_WORDS = {
  empty: "Your wallet is empty. Add funds in Structure Studio under Settings, Billing.",
  toppingUp: "Your wallet is being topped up. Try again in a minute.",
} as const;

export type WalletVerdict =
  | { refuse: true; reason: "below_floor"; availableCents: number; floorCents: number; autoTopupEnabled?: boolean }
  | { refuse: false; reason: "disarmed" | "exempt" | "above_floor" | "error"; availableCents?: number; floorCents?: number; autoTopupEnabled?: boolean };

const num = (v: unknown): number | undefined => {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** wallet_usage_gate for one meter, or the disarmed answer without asking when the rail is off. */
export async function walletFloorCheck(env: Env, admin: Admin, clientId: string, meter: string = VOICE_METER): Promise<WalletVerdict> {
  if (env.PHONE_USAGE_METERS !== "on") return { refuse: false, reason: "disarmed" };
  try {
    const { data, error } = await admin.rpc("wallet_usage_gate", { p_client_id: clientId, p_meter: meter });
    if (error) return { refuse: false, reason: "error" };
    const d = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : null;
    if (!d || typeof d.allow !== "boolean") return { refuse: false, reason: "error" };
    const availableCents = num(d.available_cents);
    const floorCents = num(d.floor_cents);
    const autoTopupEnabled = d.auto_topup_enabled === true;
    if (!d.allow) {
      // A refusal always carries its numbers; the refusal log quotes them.
      return { refuse: true, reason: "below_floor", availableCents: availableCents ?? 0, floorCents: floorCents ?? 0, autoTopupEnabled };
    }
    // An allow with a reason this file does not know (a later migration) is still an allow.
    const reason = d.reason === "disarmed" || d.reason === "exempt" ? d.reason : "above_floor";
    return { refuse: false, reason, availableCents, floorCents, autoTopupEnabled };
  } catch {
    return { refuse: false, reason: "error" };
  }
}

/** What /token tells the apps: whether calls and texts are going through, for the banner. */
export interface WalletState {
  /** ok, low (allowed, but under twice the floor), or blocked (outbound calls are refused). */
  state: "ok" | "low" | "blocked";
  /** Blocked, and auto top-up is on: a top-up has been asked for. */
  topping_up: boolean;
}

/** /token's `wallet`. Never throws; anything it cannot tell is "ok" (the floor fails open too). */
export function walletStateOf(v: WalletVerdict): WalletState {
  if (v.refuse) return { state: "blocked", topping_up: v.autoTopupEnabled === true };
  if (v.reason === "above_floor" && v.availableCents !== undefined && v.floorCents !== undefined && v.availableCents < 2 * v.floorCents) {
    return { state: "low", topping_up: false };
  }
  return { state: "ok", topping_up: false };
}

/** How long a top-up request may take before it is abandoned (the card gateway is slow). */
export const AUTO_TOPUP_TIMEOUT_MS = 35_000;

/**
 * Ask the wallet-autotopup edge function to top this tenant up, as the service role. Resolves
 * true when it answered 2xx, false otherwise; NEVER throws, so it is safe in waitUntil and in
 * the cron. A failure is logged (throttled): the next refusal or the next charge asks again.
 */
export async function requestAutoTopup(env: Env, clientId: string): Promise<boolean> {
  const base = String(env.SUPABASE_URL ?? "").replace(/\/+$/, "");
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!base || !key) return false;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), AUTO_TOPUP_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/functions/v1/wallet-autotopup`, {
      method: "POST",
      // apikey as well as the bearer: the functions gateway accepts the new-style secret key
      // there, where it is not a JWT. The function itself checks the bearer.
      headers: { "content-type": "application/json", authorization: `Bearer ${key}`, apikey: key },
      body: JSON.stringify({ client_id: clientId }),
      signal: ac.signal,
    });
    await res.arrayBuffer().catch(() => undefined);
    if (res.ok) return true;
    await logFault({
      code: "wallet_autotopup_request_failed", clientId, throttleMs: 10 * 60_000,
      message: `wallet-autotopup answered HTTP ${res.status}.`,
    });
    return false;
  } catch (e) {
    await logFault({
      code: "wallet_autotopup_request_failed", clientId, throttleMs: 10 * 60_000,
      message: ac.signal.aborted ? `wallet-autotopup did not answer in ${AUTO_TOPUP_TIMEOUT_MS / 1000} s.` : `wallet-autotopup unreachable: ${(e as Error)?.message ?? String(e)}`,
    });
    return false;
  } finally {
    clearTimeout(timer);
  }
}
