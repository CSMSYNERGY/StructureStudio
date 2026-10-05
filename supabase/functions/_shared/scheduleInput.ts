// Body-field parsing for portal-schedule, kept here so it can be unit-tested (index.ts calls
// Deno.serve at import time, so nothing in it can be imported by a test).

// The same IANA-zone validator the wallet CSV export uses (walletLedger.ts has no imports of
// its own, so this pulls nothing else in).
export { isTimeZone } from "./walletLedger.ts";

/**
 * A number from a request body, or null when there is none.
 *
 * ⚠️ BLANK IS NULL, NOT ZERO. `Number(null)` and `Number("")` are both 0 — finite — so the old
 * `Number.isFinite(Number(v)) ? n : null` turned every cleared field into a real zero. The
 * portal sends `null` for a box left empty (a driver's deck length / max width, a stop's leg
 * miles, a load's miles out/back, a repair's Repair $), so:
 *   • saving a driver with no deck length or max width wrote 0, which driver_profiles' CHECK
 *     (`is null or > 0`, migration 088) refuses — the save failed with a raw Postgres error;
 *   • a repair logged with no price stored quote_cents = 0 and showed "$0" everywhere, and the
 *     build calendar counted it as a priced $0 job instead of flagging the missing figure;
 *   • a cleared leg mileage read back as "0 mi".
 * `undefined` was already null (Number(undefined) is NaN), which is why fields the caller never
 * sent were fine and only an explicit clear went wrong.
 */
export function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" && !v.trim()) return null;
  if (typeof v !== "number" && typeof v !== "string") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * The calendar day `iso` falls on in IANA zone `tz` — "YYYY-MM-DD" — or its UTC day when no
 * usable zone was sent.
 *
 * WHY: a building serial's first block is the day the building was BUILT (163_building_serials,
 * MMDD), and it is printed on the physical tag and never re-minted. `whenIso.slice(0, 10)` is
 * the UTC day, which is already TOMORROW for a US shop from 5–8 pm local (UTC-7…-4), so a
 * building marked built at the end of the working day was tagged with the next day's date.
 * The portal sends the viewer's own zone (the shop marking it built), and that day is used.
 */
export function calendarDayIn(iso: string, tz: string | null | undefined): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return String(iso ?? "").slice(0, 10);
  if (tz) {
    try {
      const p: Record<string, string> = {};
      for (const x of new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d)) {
        p[x.type] = x.value;
      }
      if (p.year && p.month && p.day) return `${p.year}-${p.month}-${p.day}`;
    } catch { /* unknown zone — fall through to UTC, the old behaviour */ }
  }
  return d.toISOString().slice(0, 10);
}
