// ════════════════════════════════════════════════════════════════════════════════════
// RELEASE 2 · DISABLED UNLESS THE METER IS ACTIVE · the monthly line fee
// ════════════════════════════════════════════════════════════════════════════════════
//
// THE MONTHLY LINE FEE (`phone_line_monthly`, plan section 17) runs from the daily 09:00 UTC
// cron. TWO RAILS, both must be on before a cent moves, the way _shared/taxMeter.ts is armed:
//   1. env PHONE_USAGE_METERS === "on" (wrangler.jsonc ships "off");
//   2. its usage_prices row `phone_line_monthly` exists, active = true and price_cents > 0.
// One debit per tenant per calendar month (UTC), keyed phone_line_monthly:<client_id>:<YYYY-MM>,
// so the 30 daily runs of a month charge it once: the first run of the month charges, the rest
// find the key already on the ledger and skip. Charged in advance for the month, not prorated.
// A tenant has a line when its phone switch is on and it holds a voice-enabled number
// (sms_numbers.voice_enabled, not released). It checks what wallet_credit does NOT check itself
// (metered_exempt, billing_exempt), the taxMeter steps 2 and 2b. Insufficient funds is not a
// refusal here (taxMeter's posture): the line was already held.
//
// Moved here UNCHANGED from cron/usageDebit.ts (2026-10-02) when the daily combined minute
// debit was deleted: calls and texts are now charged one by one by cron/usageCharge.ts.
//
// ⚠️ wallet_credit's p_meter_kind: migration 244 records it on the row. Check before arming that
// 'phone_line_monthly' is accepted there (and shown on the Billing tab).
//
// ⚠️ ONE RENTAL FEE PER NUMBER (decided 2026-10-05). The voice-enabled number that gives a
// tenant its "line" is an sms_numbers row, and cron/numberFee.ts already charges every live row
// `sms_number_monthly` each month (the purchase took the first). This meter is priced 0, so
// nothing is charged twice today. Before pricing it, make it skip the numbers that pay
// sms_number_monthly (or retire one of the two), or a builder pays twice for one number.

import type { Env } from "../env";
import { must, type Admin } from "../db";
import { logFault } from "../log";

export const LINE_METER_KIND = "phone_line_monthly";

export type LineFeeSummary =
  | { ran: false; reason: "switched_off" | "unknown_meter" | "inactive" | "unpriced" | "error" }
  | { ran: true; month: string; tenants: number; charged: number; already: number; exempt: number; failed: number };

/** The calendar month (UTC) as YYYY-MM. */
export function utcMonth(now: Date): string {
  return now.toISOString().slice(0, 7);
}

export function lineFeeIdem(clientId: string, month: string): string {
  return `${LINE_METER_KIND}:${clientId}:${month}`;
}

/** Tenants with a phone line: switch on, and a voice-enabled number still held. */
export async function tenantsWithLine(admin: Admin): Promise<string[]> {
  const on = ((must(
    await admin.from("client_settings").select("client_id").eq("phone_status", "on").limit(10_000),
    "read phone tenants",
  ) as { client_id: string }[] | null) ?? []).map((r) => r.client_id);
  if (!on.length) return [];
  const out = new Set<string>();
  for (let i = 0; i < on.length; i += 200) {
    const rows = (must(
      await admin.from("sms_numbers").select("client_id").in("client_id", on.slice(i, i + 200))
        .eq("voice_enabled", true).is("released_at", null),
      "read voice numbers",
    ) as { client_id: string }[] | null) ?? [];
    for (const r of rows) out.add(r.client_id);
  }
  return [...out].sort();
}

export async function chargeMonthlyLineFees(env: Env, admin: Admin, now = new Date()): Promise<LineFeeSummary> {
  if (env.PHONE_USAGE_METERS !== "on") return { ran: false, reason: "switched_off" };
  try {
    const { data: price, error: priceErr } = await admin.from("usage_prices")
      .select("price_cents, active").eq("kind", LINE_METER_KIND).maybeSingle();
    if (priceErr) return { ran: false, reason: "error" };
    if (!price) return { ran: false, reason: "unknown_meter" };
    if ((price as { active: boolean }).active !== true) return { ran: false, reason: "inactive" };
    const cents = Number((price as { price_cents: number }).price_cents) || 0;
    if (cents <= 0) return { ran: false, reason: "unpriced" };

    const month = utcMonth(now);
    const tenants = await tenantsWithLine(admin);
    // Which of them this month's fee is already on the ledger for: one read, so the other 29
    // runs of the month cost nothing per tenant. wallet_credit's own replay check stays the
    // guarantee; this is only the shortcut.
    const keys = tenants.map((t) => lineFeeIdem(t, month));
    const done = new Set<string>();
    for (let i = 0; i < keys.length; i += 200) {
      const rows = (must(
        await admin.from("wallet_transactions").select("idempotency_key").in("idempotency_key", keys.slice(i, i + 200)),
        "read line fees charged",
      ) as { idempotency_key: string }[] | null) ?? [];
      for (const r of rows) done.add(r.idempotency_key);
    }

    let charged = 0;
    let already = 0;
    let exempt = 0;
    let failed = 0;
    for (const clientId of tenants) {
      const idem = lineFeeIdem(clientId, month);
      if (done.has(idem)) { already++; continue; }
      const [{ data: acct, error: aErr }, { data: cs, error: cErr }] = await Promise.all([
        admin.from("wallet_accounts").select("metered_exempt").eq("client_id", clientId).maybeSingle(),
        admin.from("client_settings").select("billing_exempt").eq("client_id", clientId).maybeSingle(),
      ]);
      if (aErr || cErr) { failed++; continue; }
      if ((acct as { metered_exempt?: boolean } | null)?.metered_exempt === true || (cs as { billing_exempt?: boolean } | null)?.billing_exempt === true) {
        exempt++;
        continue;
      }
      const { error } = await admin.rpc("wallet_credit", {
        p_client_id: clientId,
        p_amount_cents: -cents,
        p_kind: "debit",
        p_ref_type: "phone_line",
        p_ref_id: month,
        p_memo: `Phone line for ${month}`,
        p_idem: idem,
        p_actor: null,
        p_meter_kind: LINE_METER_KIND,
      });
      if (error) {
        failed++;
        // Retried by tomorrow's run with the same key; never silently dropped.
        await logFault({ code: "phone_line_fee_failed", clientId, message: `wallet_credit failed for the ${month} line fee: ${error.message}` });
        continue;
      }
      charged++;
    }
    return { ran: true, month, tenants: tenants.length, charged, already, exempt, failed };
  } catch (e) {
    await logFault({ code: "phone_line_fee_failed", message: (e as Error).message });
    return { ran: false, reason: "error" };
  }
}
