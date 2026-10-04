// Body-field parsing for portal-schedule, kept here so it can be unit-tested (index.ts calls
// Deno.serve at import time, so nothing in it can be imported by a test).

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
