// Business hours in the builder's own time zone, and (migration 264) each person's own hours in
// theirs.
//
// phone_routes.business_hours is {"mon":[["08:00","17:00"]], ...}; null means always open. A
// weekday missing from a non-null object is closed all day. A range whose end is at or before its
// start runs past midnight ("22:00"–"02:00"). A time zone Intl does not know falls back to the
// column's default rather than failing the call. phone_user_settings.ring_hours is the same shape
// (inRingHours); saving either is checked by _shared/phoneHours.ts, which is stricter than this.

import { validTimeZone } from "../../../supabase/functions/_shared/phoneHours.ts";

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const FALLBACK_TZ = "America/Chicago";

function toMinutes(hhmm: unknown): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min !== 0)) return null;
  return h * 60 + min;
}

/** Weekday key and minutes past midnight, as the clock on the builder's wall reads now. */
export function localClock(timeZone: string, now: Date): { day: string; minutes: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(now);
  } catch {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: FALLBACK_TZ, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(now);
  }
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const day = get("weekday").toLowerCase().slice(0, 3);
  const hour = Number(get("hour")) % 24;
  const minute = Number(get("minute"));
  return { day: DAYS.includes(day) ? day : "mon", minutes: hour * 60 + minute };
}

export function isOpen(
  hours: Record<string, unknown> | null | undefined,
  timeZone: string,
  now: Date = new Date(),
): boolean {
  if (!hours || typeof hours !== "object") return true;
  const { day, minutes } = localClock(timeZone, now);
  const prevDay = DAYS[(DAYS.indexOf(day) + 6) % 7];

  const inRanges = (key: string, test: (start: number, end: number) => boolean): boolean => {
    const ranges = (hours as Record<string, unknown>)[key];
    if (!Array.isArray(ranges)) return false;
    for (const r of ranges) {
      if (!Array.isArray(r) || r.length < 2) continue;
      const start = toMinutes(r[0]);
      const end = toMinutes(r[1]);
      if (start === null || end === null) continue;
      if (test(start, end)) return true;
    }
    return false;
  };

  // Today's ranges (the overnight ones count from their start until midnight).
  if (inRanges(day, (s, e) => (e > s ? minutes >= s && minutes < e : minutes >= s))) return true;
  // Yesterday's overnight ranges, from midnight until their end.
  return inRanges(prevDay, (s, e) => e <= s && minutes < e);
}

/**
 * Inside a person's own ring hours (migration 264)? Null = always. Read in the zone they set them
 * in, or the number's when they set none (or one this runtime doesn't know), so a zone that went
 * missing reads the business's clock instead of dropping them from every call. Business hours
 * are checked before this and stay the outer gate: this only ever narrows them.
 */
export function inRingHours(
  hours: Record<string, unknown> | null | undefined,
  ownTimeZone: string | null | undefined,
  numberTimeZone: string,
  now: Date = new Date(),
): boolean {
  if (!hours || typeof hours !== "object") return true;
  return isOpen(hours, validTimeZone(ownTimeZone) ? ownTimeZone : numberTimeZone, now);
}
