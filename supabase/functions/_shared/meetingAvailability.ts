// meetingAvailability.ts — the availability engine behind /book. Migration 325, phase 1 of
// MEETINGS_SCOPE.md.
//
// PURE: no database, no network, no clock of its own (`now` is passed in). That is deliberate
// — this is the one piece of the feature where a bug is invisible until a customer books a
// time the host is not free, and the only way to pin that down is a unit test that can move
// the clock and the calendar at will. See meetingAvailability.test.ts.
//
// ── THE WHOLE THING IS TIMEZONE ARITHMETIC ───────────────────────────────────────────────
// Two rules, both already written down at portal/01-core.jsx:2177 and both load-bearing here:
//
//   * A bare `yyyy-mm-dd` is a CALENDAR DAY, not an instant. `new Date("2026-11-20")` is UTC
//     midnight, which is the previous EVENING for every US tenant.
//   * Every stored instant is a timestamptz. Every RULE (weekly hours, override dates) is
//     local wall-clock plus a named zone.
//
// So: iterate in wall clock, convert each candidate to an instant, compare instants. Never
// the other way round. A host whose Tuesday runs 08:00-17:00 works those hours on both sides
// of a DST change, which means the UTC offsets of their Tuesday slots DIFFER across it — and
// a clock-change day is 23 or 25 hours long, so "start + 9 hours" is not their day's end.
// Everything below follows from that.

// ── Shapes ───────────────────────────────────────────────────────────────────────────────

/** `{"mon":[["08:00","12:00"],["13:00","17:00"]], …}` — the shape phone_user_settings.ring_hours
 *  already uses (migration 264). A missing or empty day means not available; there is no
 *  separate "day off" flag to keep in step with it. */
export type WeeklyHours = Record<string, [string, string][]>;

/** One calendar day for one host. `blocked` wins outright; otherwise `hours` REPLACES that
 *  weekday's weekly hours for this date — never merges, so an override can shrink a day. */
export type DateOverride = { onDate: string; blocked: boolean; hours: [string, string][] };

/** A window the host is not free. Already widened by whatever buffers apply — see widenBusy. */
export type BusyWindow = { startsAt: string | Date; endsAt: string | Date };

export type TypeRules = {
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  minNoticeHours: number;
  maxDaysAhead: number;
  slotIntervalMinutes: number;
};

export type AvailabilityInput = {
  timeZone: string;
  weeklyHours: WeeklyHours;
  overrides: DateOverride[];
  busy: BusyWindow[];
  type: TypeRules;
  /** Inclusive calendar-day range, in the HOST's zone. */
  fromDate: string;
  toDate: string;
  now: Date;
};

export type DayAvailability = {
  /** `yyyy-mm-dd` in the host's zone. */
  date: string;
  /** Empty for a day with nothing open — the caller still gets the day, so a calendar can
   *  grey it rather than having to guess which days were in range. */
  slots: { startsAt: string; endsAt: string }[];
};

/** A request for more than this many days is a mistake or an attempt to make us do work; the
 *  public page asks for a month at a time. max_days_ahead caps how far out, this caps one call. */
export const MAX_RANGE_DAYS = 62;

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

// ── Zone primitives ──────────────────────────────────────────────────────────────────────

function zoneParts(utcMs: number, timeZone: string) {
  // `hourCycle: "h23"` matters: with hour12:false some engines render midnight as hour 24,
  // which silently becomes the next day when fed back through Date.UTC.
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(utcMs)) {
    if (part.type !== "literal") p[part.type] = part.value;
  }
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour, mm: +p.minute, ss: +p.second };
}

function partsAsUtcMs(p: { y: number; m: number; d: number; hh: number; mm: number; ss: number }) {
  return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
}

function zoneOffsetMs(utcMs: number, timeZone: string) {
  return partsAsUtcMs(zoneParts(utcMs, timeZone)) - utcMs;
}

/**
 * A wall-clock time in a named zone → the UTC instant, or **null when that time does not
 * exist** (the spring-forward gap: 02:30 simply never happens on the day the clocks go
 * forward, and a slot offered there would be unbookable).
 *
 * Two passes, which is not belt-and-braces: the first guess uses the offset at the WRONG
 * instant (the wall time read as if it were UTC), and on the day of a transition that can be
 * the offset from the other side of it. The second pass re-reads the offset at the corrected
 * instant. The round-trip check afterwards is what catches the gap.
 *
 * AMBIGUOUS times (the fall-back hour, which happens twice) resolve to the FIRST of the two
 * occurrences, deterministically. Offering both would mean two slots a customer cannot tell
 * apart, so one of them has to go; the earlier one is the one a reasonable person means.
 */
export function zonedWallToUtc(
  y: number,
  m: number,
  d: number,
  hh: number,
  mm: number,
  timeZone: string,
): number | null {
  const wallAsUtc = Date.UTC(y, m - 1, d, hh, mm, 0);
  let utc = wallAsUtc - zoneOffsetMs(wallAsUtc, timeZone);
  utc = wallAsUtc - zoneOffsetMs(utc, timeZone);
  const back = zoneParts(utc, timeZone);
  if (back.y !== y || back.m !== m || back.d !== d || back.hh !== hh || back.mm !== mm) return null;
  return utc;
}

/** `yyyy-mm-dd` → its three numbers. Refuses anything else rather than letting Date parse it. */
export function parseDay(day: string): { y: number; m: number; d: number } | null {
  const mt = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || "");
  if (!mt) return null;
  const y = +mt[1], m = +mt[2], d = +mt[3];
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  // Reject 31 February and friends by round-tripping through the calendar.
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
  return { y, m, d };
}

function dayString(y: number, m: number, d: number) {
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${y}-${p2(m)}-${p2(d)}`;
}

/** "08:30" → 510 minutes past midnight. null on anything malformed. */
function parseWall(t: string): number | null {
  const mt = /^(\d{1,2}):(\d{2})$/.exec(String(t || "").trim());
  if (!mt) return null;
  const hh = +mt[1], mm = +mt[2];
  if (hh > 23 || mm > 59) return null;
  return hh * 60 + mm;
}

/** The weekday key for a CALENDAR DATE. A date's weekday is a property of the date itself,
 *  so UTC is the right frame here and no zone is needed — the one place in this file where
 *  reaching for the zone would be the error. */
function dayKeyFor(y: number, m: number, d: number) {
  return DAY_KEYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

function msOf(v: string | Date) {
  return v instanceof Date ? v.getTime() : Date.parse(v);
}

// ── Widening ─────────────────────────────────────────────────────────────────────────────

/**
 * Turns booked meetings into busy windows, each widened by ITS OWN type's buffers.
 *
 * ⚠️ This mirrors the overlap test inside `book_meeting()` (migration 326). The two must
 * agree: this one decides what a customer is OFFERED, that one decides what is ACCEPTED, and
 * if this is the more generous of the two then customers are shown times the database then
 * refuses — which reads as a broken page, not as a race.
 */
export function widenBusy(
  rows: { startsAt: string | Date; endsAt: string | Date; bufferBeforeMinutes?: number; bufferAfterMinutes?: number }[],
): BusyWindow[] {
  return rows.map((r) => ({
    startsAt: new Date(msOf(r.startsAt) - (r.bufferBeforeMinutes || 0) * 60_000).toISOString(),
    endsAt: new Date(msOf(r.endsAt) + (r.bufferAfterMinutes || 0) * 60_000).toISOString(),
  }));
}

// ── The engine ───────────────────────────────────────────────────────────────────────────

/**
 * Every open slot for one host and one meeting type, day by day, in the host's zone.
 *
 * Order of operations, and each step's reason:
 *   1. candidate starts from the day's hours, stepping by slotIntervalMinutes
 *   2. a date override REPLACES the day (blocked -> nothing)
 *   3. drop anything whose window collides with a busy window (bookings + external calendar)
 *   4. drop anything inside minNoticeHours or past maxDaysAhead
 *
 * Returns ISO instants. The caller renders them in the CUSTOMER's zone and names the host's
 * zone on screen; this function neither knows nor cares what the customer's zone is.
 */
export function availableSlots(input: AvailabilityInput): DayAvailability[] {
  const { timeZone, weeklyHours, overrides, busy, type, fromDate, toDate, now } = input;

  const from = parseDay(fromDate);
  const to = parseDay(toDate);
  if (!from || !to) return [];

  const duration = Math.max(1, type.durationMinutes | 0);
  const step = Math.max(1, (type.slotIntervalMinutes | 0) || 15);
  const bufBefore = Math.max(0, type.bufferBeforeMinutes | 0);
  const bufAfter = Math.max(0, type.bufferAfterMinutes | 0);

  const nowMs = now.getTime();
  const earliest = nowMs + Math.max(0, type.minNoticeHours | 0) * 3_600_000;
  // maxDaysAhead is counted from NOW in whole days. A day-granularity cap read off the
  // calendar would depend on the reader's zone; this does not.
  const latest = nowMs + Math.max(1, type.maxDaysAhead | 0) * 86_400_000;

  const byDate = new Map<string, DateOverride>();
  for (const o of overrides || []) if (o && o.onDate) byDate.set(o.onDate, o);

  const busyWindows = (busy || [])
    .map((b) => ({ s: msOf(b.startsAt), e: msOf(b.endsAt) }))
    .filter((b) => Number.isFinite(b.s) && Number.isFinite(b.e) && b.e > b.s)
    .sort((a, b) => a.s - b.s);

  const out: DayAvailability[] = [];
  let cursor = Date.UTC(from.y, from.m - 1, from.d);
  const end = Date.UTC(to.y, to.m - 1, to.d);
  let guard = 0;

  while (cursor <= end && guard++ < MAX_RANGE_DAYS) {
    const cd = new Date(cursor);
    const y = cd.getUTCFullYear(), m = cd.getUTCMonth() + 1, d = cd.getUTCDate();
    const date = dayString(y, m, d);

    const ov = byDate.get(date);
    let blocks: [string, string][];
    if (ov) blocks = ov.blocked ? [] : (ov.hours || []);
    else blocks = weeklyHours?.[dayKeyFor(y, m, d)] || [];

    const slots: { startsAt: string; endsAt: string }[] = [];

    for (const block of blocks) {
      const openAt = parseWall(block?.[0]);
      const closeAt = parseWall(block?.[1]);
      if (openAt === null || closeAt === null || closeAt <= openAt) continue;

      // Walk WALL-CLOCK minutes. The last slot must FINISH by closing time, so the loop
      // bound is `+ duration <= closeAt` — not `start < closeAt`, which would offer a slot
      // that runs past the end of the day.
      for (let mins = openAt; mins + duration <= closeAt; mins += step) {
        const startMs = zonedWallToUtc(y, m, d, Math.floor(mins / 60), mins % 60, timeZone);
        if (startMs === null) continue; // a time inside the spring-forward gap
        const endMs = startMs + duration * 60_000;

        if (startMs < earliest || startMs > latest) continue;

        const winS = startMs - bufBefore * 60_000;
        const winE = endMs + bufAfter * 60_000;
        let clash = false;
        for (const b of busyWindows) {
          if (b.s >= winE) break; // sorted, so nothing later can overlap
          if (b.e > winS) { clash = true; break; }
        }
        if (clash) continue;

        slots.push({ startsAt: new Date(startMs).toISOString(), endsAt: new Date(endMs).toISOString() });
      }
    }

    // Two blocks can both produce the same start when a tenant's hours overlap (08:00-12:00
    // and 11:00-15:00 is a save we accept rather than refuse). Offering one time twice looks
    // broken, so collapse here instead of trusting the data.
    slots.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    const deduped = slots.filter((s, i) => i === 0 || s.startsAt !== slots[i - 1].startsAt);

    out.push({ date, slots: deduped });
    cursor += 86_400_000;
  }

  return out;
}
