// ════════════════════════════════════════════════════════════════════════════════════
// RELEASE 2 · DISABLED UNLESS THE METERS ARE ACTIVE · the daily call-minute debit
// ════════════════════════════════════════════════════════════════════════════════════
//
// Plan section 17: the wallet's hold/capture flow cannot do usage (a hold is exactly one unit
// price, and only one can be open per meter), so a Cron Trigger posts ONE direct debit per
// tenant per UTC day through wallet_credit, for that day's minutes times the meter price.
// This follows _shared/taxMeter.ts's pattern exactly, including the checks wallet_credit does
// NOT do itself (price armed, metered_exempt, billing_exempt).
//
// TWO RAILS, both must be on before a cent moves:
//   1. env PHONE_USAGE_METERS === "on" (wrangler.jsonc ships "off");
//   2. usage_prices row `voice_minute` exists, active = true and price_cents > 0. No migration
//      seeds it yet; the plan says to seed it switched off, like the SMS meters in 169.
// IDEMPOTENT per tenant + date: p_idem = voice_minute:<client_id>:<YYYY-MM-DD>, so a rerun,
// a retry or a second isolate can never charge a day twice (wallet_credit treats a repeated key
// as a no-op). Insufficient funds is not a refusal here, the taxMeter posture: the calls were
// already made, and the balance goes negative until the wallet floor (section 17) stops the
// next outbound call.
//
// CATCH-UP (plan 17: "a charge that fails is retried ... never dropped"). Each run looks at the
// last CATCH_UP_DAYS UTC days, not just yesterday, and charges every tenant-day with minutes
// whose key is not on the ledger yet. So a charge that failed, or a whole run that failed or
// never happened, is picked up by the next run for up to a week. One ledger read finds the keys
// already charged, so a day that went through costs nothing again.
//   The window never reaches back before the first day this job ever charged (the earliest
//   phone_minutes row on the ledger). The first run after the meter is armed therefore charges
//   only yesterday, never the calls made while it was off. Known edge: if the meter is
//   disarmed for a few days and armed again, the next run charges any of those days still
//   inside the window.
//
// ⚠️ wallet_credit's p_meter_kind: migration 244 records it on the row. Check before arming that
// 'voice_minute' is accepted there (and shown on the Billing tab) — this stub has not been run
// against the live function.
//
// THE MONTHLY LINE FEE (`phone_line_monthly`, plan section 17) runs from the same daily cron,
// on the same two rails (PHONE_USAGE_METERS on, and its own usage_prices row active and
// priced). One debit per tenant per calendar month (UTC), keyed
// phone_line_monthly:<client_id>:<YYYY-MM>, so the 30 daily runs of a month charge it once:
// the first run of the month charges, the rest find the key already on the ledger and skip.
// Charged in advance for the month, not prorated. A tenant has a line when its phone switch is
// on and it holds a voice-enabled number (sms_numbers.voice_enabled, not released).

import type { Env } from "../env";
import { must, type Admin } from "../db";
import { logFault } from "../log";

export const METER_KIND = "voice_minute";
/** The wallet_transactions.ref_type of a minute debit (its ref_id is the UTC day). */
export const MINUTES_REF_TYPE = "phone_minutes";
/** How many UTC days back each run looks for minutes not charged yet (yesterday included). */
export const CATCH_UP_DAYS = 7;

export type DebitSummary =
  | { ran: false; reason: "switched_off" | "unknown_meter" | "inactive" | "unpriced" | "error" }
  | { ran: true; days: string[]; tenants: number; charged: number; already: number; exempt: number; failed: number };

export function voiceMinuteIdem(clientId: string, date: string): string {
  return `${METER_KIND}:${clientId}:${date}`;
}

/** Yesterday, UTC, as YYYY-MM-DD. */
export function previousUtcDay(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1)).toISOString().slice(0, 10);
}

/** The UTC days from `first` to `last` (YYYY-MM-DD, both included), oldest first. */
export function utcDays(first: string, last: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${first}T00:00:00.000Z`); t <= Date.parse(`${last}T00:00:00.000Z`); t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Billable minutes per UTC day (by started_at) and tenant, for the days `first` to `last`:
 * each call rounded up, as Twilio bills.
 */
export async function minutesByDay(admin: Admin, first: string, last: string): Promise<Map<string, Map<string, number>>> {
  const start = `${first}T00:00:00.000Z`;
  const end = new Date(Date.parse(`${last}T00:00:00.000Z`) + 86_400_000).toISOString();
  const out = new Map<string, Map<string, number>>();
  for (let from = 0; ; from += 1000) {
    const rows = (must(
      await admin.from("phone_calls").select("client_id, started_at, duration_s")
        .gte("started_at", start).lt("started_at", end).gt("duration_s", 0)
        .order("id", { ascending: true }).range(from, from + 999),
      "read call minutes",
    ) as { client_id: string; started_at: string; duration_s: number }[] | null) ?? [];
    for (const r of rows) {
      const t = Date.parse(r.started_at);
      if (!Number.isFinite(t)) continue;
      const day = new Date(t).toISOString().slice(0, 10);
      const byTenant = out.get(day) ?? new Map<string, number>();
      byTenant.set(r.client_id, (byTenant.get(r.client_id) ?? 0) + Math.ceil(Number(r.duration_s) / 60));
      out.set(day, byTenant);
    }
    if (rows.length < 1000) break;
  }
  return out;
}

/** The days this run may charge: CATCH_UP_DAYS back, never before the job's first charge. */
async function daysToCharge(admin: Admin, now: Date): Promise<string[]> {
  const last = previousUtcDay(now);
  const windowStart = new Date(Date.parse(`${last}T00:00:00.000Z`) - (CATCH_UP_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
  const firstRow = must(
    await admin.from("wallet_transactions").select("ref_id").eq("ref_type", MINUTES_REF_TYPE)
      .order("ref_id", { ascending: true }).limit(1).maybeSingle(),
    "read first minute debit",
  ) as { ref_id?: string | null } | null;
  const firstCharged = /^\d{4}-\d{2}-\d{2}$/.test(String(firstRow?.ref_id ?? "")) ? String(firstRow!.ref_id) : null;
  // Never charged before: only yesterday (the calls made before arming are not billed).
  if (!firstCharged || firstCharged > last) return [last];
  return utcDays(firstCharged > windowStart ? firstCharged : windowStart, last);
}

export async function debitDailyUsage(env: Env, admin: Admin, now = new Date()): Promise<DebitSummary> {
  if (env.PHONE_USAGE_METERS !== "on") return { ran: false, reason: "switched_off" };
  try {
    // Rail 2: the arming row (taxMeter step 1).
    const { data: price, error: priceErr } = await admin.from("usage_prices")
      .select("price_cents, active").eq("kind", METER_KIND).maybeSingle();
    if (priceErr) return { ran: false, reason: "error" };
    if (!price) return { ran: false, reason: "unknown_meter" };
    if ((price as { active: boolean }).active !== true) return { ran: false, reason: "inactive" };
    const cents = Number((price as { price_cents: number }).price_cents) || 0;
    if (cents <= 0) return { ran: false, reason: "unpriced" };

    const days = await daysToCharge(admin, now);
    const usage = await minutesByDay(admin, days[0], days[days.length - 1]);

    // Every tenant-day with minutes, oldest day first, and which of them are on the ledger.
    const owed: { clientId: string; date: string; minutes: number }[] = [];
    for (const date of days) {
      const byTenant = [...(usage.get(date) ?? new Map<string, number>())].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      for (const [clientId, minutes] of byTenant) {
        if (minutes > 0) owed.push({ clientId, date, minutes });
      }
    }
    const keys = owed.map((o) => voiceMinuteIdem(o.clientId, o.date));
    const done = new Set<string>();
    for (let i = 0; i < keys.length; i += 200) {
      const rows = (must(
        await admin.from("wallet_transactions").select("idempotency_key").in("idempotency_key", keys.slice(i, i + 200)),
        "read minutes charged",
      ) as { idempotency_key: string }[] | null) ?? [];
      for (const r of rows) done.add(r.idempotency_key);
    }

    let charged = 0;
    let already = 0;
    let exempt = 0;
    let failed = 0;
    // taxMeter steps 2 and 2b, once per tenant per run: our own and non-billable accounts are
    // never charged. A failed read skips that tenant this run; the next run tries again.
    const exemptOf = new Map<string, boolean | null>();
    for (const o of owed) {
      const idem = voiceMinuteIdem(o.clientId, o.date);
      if (done.has(idem)) { already++; continue; }
      if (!exemptOf.has(o.clientId)) {
        const [{ data: acct, error: aErr }, { data: cs, error: cErr }] = await Promise.all([
          admin.from("wallet_accounts").select("metered_exempt").eq("client_id", o.clientId).maybeSingle(),
          admin.from("client_settings").select("billing_exempt").eq("client_id", o.clientId).maybeSingle(),
        ]);
        exemptOf.set(o.clientId, aErr || cErr ? null
          : (acct as { metered_exempt?: boolean } | null)?.metered_exempt === true || (cs as { billing_exempt?: boolean } | null)?.billing_exempt === true);
      }
      const isExempt = exemptOf.get(o.clientId);
      if (isExempt === null) { failed++; continue; }
      if (isExempt) { exempt++; continue; }
      const { error } = await admin.rpc("wallet_credit", {
        p_client_id: o.clientId,
        p_amount_cents: -(o.minutes * cents),
        p_kind: "debit",
        p_ref_type: MINUTES_REF_TYPE,
        p_ref_id: o.date,
        p_memo: `${o.minutes} call minute${o.minutes === 1 ? "" : "s"} on ${o.date}`,
        p_idem: idem,
        p_actor: null,
        p_meter_kind: METER_KIND,
      });
      if (error) {
        failed++;
        // Not on the ledger, so the next run (up to CATCH_UP_DAYS later) charges it again.
        await logFault({ code: "phone_usage_debit_failed", clientId: o.clientId, message: `wallet_credit failed for ${o.date}: ${error.message}` });
        continue;
      }
      charged++;
    }
    const tenants = new Set(owed.map((o) => o.clientId)).size;
    return { ran: true, days, tenants, charged, already, exempt, failed };
  } catch (e) {
    await logFault({ code: "phone_usage_debit_failed", message: (e as Error).message });
    return { ran: false, reason: "error" };
  }
}

// ── The monthly line fee ─────────────────────────────────────────────────────────────

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
