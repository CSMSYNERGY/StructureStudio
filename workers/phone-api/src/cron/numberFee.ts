// ════════════════════════════════════════════════════════════════════════════════════
// INERT UNTIL THE METER IS ARMED · each number's monthly fee, from its second month on
// ════════════════════════════════════════════════════════════════════════════════════
//
// THE MONTHLY NUMBER FEE (`sms_number_monthly`) runs from the daily 09:00 UTC cron. A business
// number bills us at Twilio every month from the day it is bought. The PURCHASE charges the
// first month: portal-sms `buy_number` and portal-settings' calling-only purchase
// (phoneNumber.ts buyCallingNumber) both take a wallet hold on this meter under
// `sms_num:<client>:<number>`. Until this file nothing charged month 2 on, so once the meter was
// armed a number billed us monthly and the builder once (SMS work log, 2026-08-30).
//
// ONE RAIL, the one month 1 already uses: its usage_prices row `sms_number_monthly` exists,
// active = true and price_cents > 0. No env var, on purpose: a second switch could arm month 1
// and leave months 2+ off, which is the bug this closes. Disarmed (it ships active = false),
// this reads that one row a day and charges nothing.
//
// PERIODS run from each number's own purchase day (UTC), not the calendar month, because that is
// when Twilio bills it and when month 1 was taken. Period n starts n months after purchased_at,
// on the same day of the month clamped to the month's last day (bought Jan 31: Feb 28 or 29,
// then Mar 31; the clamp never drags later months down). It is charged on that UTC day's run,
// in advance and not prorated, like the line fee.
//   - Period 0 is the purchase's own, paid by the hold, so it is never charged here.
//   - Only the CURRENT period is charged. Arming the meter in month 6 charges month 6, not 2 to
//     6, and a period every run missed is never billed later.
// One debit per number per period, keyed sms_number_monthly:<number_id>:m<n>: a different key
// from month 1's, so the purchase is never charged again, and the 30 daily runs of a period
// charge it once (the first finds no key; the rest find it on the ledger and skip).
//
// WHO PAYS: every live number (sms_numbers.released_at null), texting and calling-only alike,
// since both purchases hold month 1 on this meter. A released number stops paying. It checks
// what wallet_credit does NOT check itself (metered_exempt, billing_exempt), as the line fee
// does. A number whose tenant is gone (no client_configs row: delete_client wipes the tenant but
// neither releases its numbers nor their rows) is not charged; it is logged as a warning,
// because we still rent it at Twilio and someone has to release it. Insufficient funds is not a
// refusal (the line fee's posture): the business still rents the number, wallet_credit lets the
// balance go below zero, and auto top-up is asked as it is after call and text charges.
//
// ⚠️ ONE RENTAL FEE PER NUMBER. cron/lineFee.ts's `phone_line_monthly` charges a tenant for
// holding a voice-enabled number, which is the SAME sms_numbers row this fee charges for. It is
// priced 0 today, so nothing is charged twice. Pricing it later must make it skip the numbers
// that pay this fee, or retire one of the two.

import type { Env } from "../env";
import { must, type Admin } from "../db";
import { logFault } from "../log";
import { requestAutoTopup } from "../wallet";

export const NUMBER_METER_KIND = "sms_number_monthly";

/** PostgREST answers at most db-max-rows (1000 on this project) per request. */
const PAGE = 1000;
/** Ids per `in.(...)` filter, as the line fee reads. */
const CHUNK = 200;

export type NumberFeeSummary =
  | { ran: false; reason: "unknown_meter" | "inactive" | "unpriced" | "error" }
  | {
    ran: true;
    /** Tenants holding a live number. */
    tenants: number;
    /** Live numbers. */
    numbers: number;
    /** Still in their purchase period (paid by the purchase). */
    firstMonth: number;
    charged: number;
    already: number;
    exempt: number;
    /** Live numbers whose tenant no longer exists. */
    gone: number;
    failed: number;
    topups: number;
  };

interface LiveNumber {
  id: string;
  client_id: string;
  purchased_at: string;
}

function daysInMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

/**
 * Which period a number is in on `now`'s UTC day: 0 from its purchase day, 1 from the same day
 * a month later (clamped to the month's last day), and so on. Negative before the purchase day,
 * NaN for a date that does not parse. Only periods 1 and up are charged here.
 */
export function numberPeriod(purchasedAt: string | Date, now: Date): number {
  const p = new Date(purchasedAt);
  if (!Number.isFinite(p.getTime())) return Number.NaN;
  let n = (now.getUTCFullYear() - p.getUTCFullYear()) * 12 + (now.getUTCMonth() - p.getUTCMonth());
  const dueDay = Math.min(p.getUTCDate(), daysInMonth(now.getUTCFullYear(), now.getUTCMonth()));
  if (now.getUTCDate() < dueDay) n -= 1;
  return n;
}

/** Month 1 is `sms_num:<client>:<number>` (the purchase hold); this is months 2 and on. */
export function numberFeeIdem(numberId: string, period: number): string {
  return `${NUMBER_METER_KIND}:${numberId}:m${period}`;
}

/** What the ledger line says: period 1 is the number's second month. */
export function numberFeeMemo(period: number): string {
  return `Phone number fee, month ${period + 1}`;
}

async function liveNumbers(admin: Admin): Promise<LiveNumber[]> {
  const out: LiveNumber[] = [];
  for (let from = 0; ; from += PAGE) {
    const rows = (must(
      await admin.from("sms_numbers").select("id, client_id, purchased_at")
        .is("released_at", null).order("id").range(from, from + PAGE - 1),
      "read live numbers",
    ) as LiveNumber[] | null) ?? [];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

/** Rows of `table` for these tenants, read CHUNK ids at a time. Throws on a failed read. */
async function rowsFor<T>(admin: Admin, table: string, columns: string, ids: string[]): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const rows = (must(
      await admin.from(table).select(columns).in("client_id", ids.slice(i, i + CHUNK)),
      `read ${table}`,
    ) as T[] | null) ?? [];
    out.push(...rows);
  }
  return out;
}

export async function chargeMonthlyNumberFees(env: Env, admin: Admin, now = new Date()): Promise<NumberFeeSummary> {
  try {
    const { data: price, error: priceErr } = await admin.from("usage_prices")
      .select("price_cents, active").eq("kind", NUMBER_METER_KIND).maybeSingle();
    if (priceErr) {
      await logFault({ code: "sms_number_fee_failed", message: `Could not read the ${NUMBER_METER_KIND} price: ${priceErr.message}` });
      return { ran: false, reason: "error" };
    }
    if (!price) return { ran: false, reason: "unknown_meter" };
    if ((price as { active: boolean }).active !== true) return { ran: false, reason: "inactive" };
    const cents = Number((price as { price_cents: number }).price_cents) || 0;
    if (cents <= 0) return { ran: false, reason: "unpriced" };

    // Every read before the first charge, so a failed read charges nobody and tomorrow's run
    // (still inside the same periods) does the whole job.
    const numbers = await liveNumbers(admin);
    let firstMonth = 0;
    const due: { row: LiveNumber; period: number; idem: string }[] = [];
    for (const row of numbers) {
      const period = numberPeriod(row.purchased_at, now);
      if (!(period >= 1)) { firstMonth++; continue; }
      due.push({ row, period, idem: numberFeeIdem(row.id, period) });
    }

    // Which of them this period's fee is already on the ledger for: one read per 200, so the
    // other 29 runs of a period cost nothing per number. wallet_credit's own replay check stays
    // the guarantee; this is only the shortcut. The tenants are in the filter too, so the read
    // can use wallet_tx_idem (client_id, idempotency_key) on a ledger of every call and text.
    const done = new Set<string>();
    for (let i = 0; i < due.length; i += CHUNK) {
      const chunk = due.slice(i, i + CHUNK);
      const rows = (must(
        await admin.from("wallet_transactions").select("idempotency_key")
          .in("client_id", [...new Set(chunk.map((d) => d.row.client_id))])
          .in("idempotency_key", chunk.map((d) => d.idem)),
        "read number fees charged",
      ) as { idempotency_key: string }[] | null) ?? [];
      for (const r of rows) done.add(r.idempotency_key);
    }
    const todo = due.filter((d) => !done.has(d.idem));
    const already = due.length - todo.length;

    const ids = [...new Set(todo.map((d) => d.row.client_id))].sort();
    const [configs, accounts, settings] = await Promise.all([
      rowsFor<{ client_id: string }>(admin, "client_configs", "client_id", ids),
      rowsFor<{ client_id: string; metered_exempt?: boolean }>(admin, "wallet_accounts", "client_id, metered_exempt", ids),
      rowsFor<{ client_id: string; billing_exempt?: boolean }>(admin, "client_settings", "client_id, billing_exempt", ids),
    ]);
    const live = new Set(configs.map((r) => r.client_id));
    const exemptIds = new Set([
      ...accounts.filter((r) => r.metered_exempt === true).map((r) => r.client_id),
      ...settings.filter((r) => r.billing_exempt === true).map((r) => r.client_id),
    ]);

    let charged = 0;
    let exempt = 0;
    let gone = 0;
    let failed = 0;
    const chargedTenants = new Set<string>();
    for (const { row, period, idem } of todo) {
      const clientId = row.client_id;
      if (!live.has(clientId)) {
        gone++;
        await logFault({
          code: "sms_number_fee_no_tenant", clientId, severity: "warn", context: { number_id: row.id },
          message: "A live number belongs to a tenant that no longer exists. It still bills at Twilio: release it there and stamp sms_numbers.released_at.",
        });
        continue;
      }
      if (exemptIds.has(clientId)) { exempt++; continue; }
      const { error } = await admin.rpc("wallet_credit", {
        p_client_id: clientId,
        p_amount_cents: -cents,
        p_kind: "debit",
        p_ref_type: "sms_number",
        p_ref_id: row.id,
        p_memo: numberFeeMemo(period),
        p_idem: idem,
        p_actor: null,
        p_meter_kind: NUMBER_METER_KIND,
      });
      if (error) {
        failed++;
        // Retried by tomorrow's run with the same key while the period lasts; never silently dropped.
        await logFault({
          code: "sms_number_fee_failed", clientId, context: { number_id: row.id, period },
          message: `wallet_credit failed for a number's month ${period + 1} fee: ${error.message}`,
        });
        continue;
      }
      charged++;
      chargedTenants.add(clientId);
    }

    const topups = await autoTopUps(env, admin, [...chargedTenants].sort());
    return {
      ran: true, tenants: new Set(numbers.map((n) => n.client_id)).size, numbers: numbers.length,
      firstMonth, charged, already, exempt, gone, failed, topups,
    };
  } catch (e) {
    await logFault({ code: "sms_number_fee_failed", message: (e as Error)?.message ?? String(e) });
    return { ran: false, reason: "error" };
  }
}

/**
 * The call and text charges' rule (usageCharge.ts autoTopUps): one request per tenant charged
 * this run whose spendable balance (balance − held) is now under its auto top-up threshold. The
 * edge function re-reads the wallet and applies its own cooldown. Never throws: the fees are
 * already posted, and the next charge or refusal asks again.
 */
async function autoTopUps(env: Env, admin: Admin, ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  try {
    const rows = await rowsFor<{
      client_id: string; balance_cents?: number | string; held_cents?: number | string;
      auto_topup_enabled?: boolean; auto_topup_threshold_cents?: number | string | null;
    }>(admin, "wallet_accounts", "client_id, balance_cents, held_cents, auto_topup_enabled, auto_topup_threshold_cents", ids);
    const due = rows.filter((r) => {
      const threshold = Number(r.auto_topup_threshold_cents);
      const available = (Number(r.balance_cents) || 0) - (Number(r.held_cents) || 0);
      return r.auto_topup_enabled === true && Number.isFinite(threshold) && threshold > 0 && available < threshold;
    });
    await Promise.all(due.map((r) => requestAutoTopup(env, r.client_id)));
    return due.length;
  } catch (e) {
    await logFault({ code: "sms_number_fee_topup_failed", severity: "warn", message: (e as Error)?.message ?? String(e) });
    return 0;
  }
}
