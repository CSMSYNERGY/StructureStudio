// meetingAvailability.test.ts — the availability engine, pinned. Migration 325.
//
// Why this file exists: a bug in this engine does not throw and does not log. It offers a
// customer a time the host is not free, or hides a time they are, and nobody finds out until
// two people turn up at a lot at once. Every case below is one way that can happen.
//
// The DST cases are the point of the file. America/Chicago moves on 2026-03-08 (02:00 ->
// 03:00) and back on 2026-11-01 (02:00 -> 01:00), and both are inside a 60-day booking
// window for most of the year.
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  availableSlots,
  widenBusy,
  zonedWallToUtc,
  parseDay,
  MAX_RANGE_DAYS,
} from "./meetingAvailability.ts";

const TZ = "America/Chicago";

const TYPE = {
  durationMinutes: 30,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  minNoticeHours: 0,
  maxDaysAhead: 365,
  slotIntervalMinutes: 30,
};

// 2026-10-20 is a Tuesday. Every "now" below is early that morning unless a case moves it.
const NOW = new Date("2026-10-20T06:00:00Z");

const HOURS_9_TO_11 = { tue: [["09:00", "11:00"]] } as Record<string, [string, string][]>;

function day(res: ReturnType<typeof availableSlots>, date: string) {
  const d = res.find((r) => r.date === date);
  if (!d) throw new Error(`no day ${date} in result`);
  return d;
}

function starts(res: ReturnType<typeof availableSlots>, date: string) {
  return day(res, date).slots.map((s) => s.startsAt);
}

// ── Zone primitives ──────────────────────────────────────────────────────────────────────

Deno.test("wall clock converts to the right instant on both sides of a DST change", () => {
  // CST (UTC-6) in January, CDT (UTC-5) in July. Same wall time, different instants: this is
  // the whole reason the engine iterates in wall clock and not in elapsed hours.
  assertEquals(new Date(zonedWallToUtc(2026, 1, 13, 9, 0, TZ)!).toISOString(), "2026-01-13T15:00:00.000Z");
  assertEquals(new Date(zonedWallToUtc(2026, 7, 14, 9, 0, TZ)!).toISOString(), "2026-07-14T14:00:00.000Z");
});

Deno.test("a time inside the spring-forward gap does not exist", () => {
  // 2026-03-08: 02:00 -> 03:00. 02:30 never happens, so a slot there is unbookable.
  assertEquals(zonedWallToUtc(2026, 3, 8, 2, 30, TZ), null);
  // 01:30 and 03:30 that same morning are both real.
  assert(zonedWallToUtc(2026, 3, 8, 1, 30, TZ) !== null);
  assert(zonedWallToUtc(2026, 3, 8, 3, 30, TZ) !== null);
});

Deno.test("an ambiguous fall-back time resolves to the first occurrence", () => {
  // 2026-11-01: 02:00 -> 01:00, so 01:30 happens twice — 06:30Z (CDT) and 07:30Z (CST).
  // Either is defensible; what matters is that it is deterministic and really is 01:30 local.
  const ms = zonedWallToUtc(2026, 11, 1, 1, 30, TZ);
  assert(ms !== null);
  assertEquals(new Date(ms!).toISOString(), "2026-11-01T06:30:00.000Z");
});

Deno.test("parseDay refuses what Date would happily guess", () => {
  assertEquals(parseDay("2026-02-31"), null);
  assertEquals(parseDay("2026-13-01"), null);
  assertEquals(parseDay("26-01-01"), null);
  assertEquals(parseDay(""), null);
  assertEquals(parseDay("2026-10-20"), { y: 2026, m: 10, d: 20 });
});

// ── Slot generation ──────────────────────────────────────────────────────────────────────

Deno.test("a plain day yields the expected slots, in the host's zone", () => {
  const res = availableSlots({
    timeZone: TZ, weeklyHours: HOURS_9_TO_11, overrides: [], busy: [],
    type: TYPE, fromDate: "2026-10-20", toDate: "2026-10-20", now: NOW,
  });
  // 09:00, 09:30, 10:00, 10:30 — CDT in October, so UTC-5.
  assertEquals(starts(res, "2026-10-20"), [
    "2026-10-20T14:00:00.000Z",
    "2026-10-20T14:30:00.000Z",
    "2026-10-20T15:00:00.000Z",
    "2026-10-20T15:30:00.000Z",
  ]);
});

Deno.test("the last slot must FINISH by closing time", () => {
  // 09:00-11:00 with a 60-minute meeting: 09:00, 09:30, 10:00. NOT 10:30, which would run to
  // 11:30 — half an hour past the end of the host's day.
  const res = availableSlots({
    timeZone: TZ, weeklyHours: HOURS_9_TO_11, overrides: [], busy: [],
    type: { ...TYPE, durationMinutes: 60 }, fromDate: "2026-10-20", toDate: "2026-10-20", now: NOW,
  });
  assertEquals(starts(res, "2026-10-20").length, 3);
  assertEquals(day(res, "2026-10-20").slots[2].endsAt, "2026-10-20T16:00:00.000Z"); // 11:00 local
});

Deno.test("a day the host does not work yields a day with no slots, not a missing day", () => {
  // The calendar needs every day in range so it can grey the closed ones; a missing key would
  // make "closed" and "out of range" look the same.
  const res = availableSlots({
    timeZone: TZ, weeklyHours: HOURS_9_TO_11, overrides: [], busy: [],
    type: TYPE, fromDate: "2026-10-19", toDate: "2026-10-21", now: NOW,
  });
  assertEquals(res.map((r) => r.date), ["2026-10-19", "2026-10-20", "2026-10-21"]);
  assertEquals(day(res, "2026-10-19").slots.length, 0); // Monday, no hours
  assertEquals(day(res, "2026-10-21").slots.length, 0); // Wednesday, no hours
  assert(day(res, "2026-10-20").slots.length > 0);
});

Deno.test("two blocks in one day both produce slots, and a shared start appears once", () => {
  const res = availableSlots({
    timeZone: TZ,
    // Deliberately OVERLAPPING blocks: 10:00 falls in both. A duplicate time on screen reads
    // as a broken page, so the engine collapses it rather than trusting the saved data.
    weeklyHours: { tue: [["09:00", "11:00"], ["10:00", "12:00"]] },
    overrides: [], busy: [], type: TYPE,
    fromDate: "2026-10-20", toDate: "2026-10-20", now: NOW,
  });
  const s = starts(res, "2026-10-20");
  assertEquals(new Set(s).size, s.length, "no duplicate starts");
  assertEquals(s, [
    "2026-10-20T14:00:00.000Z", // 09:00
    "2026-10-20T14:30:00.000Z", // 09:30
    "2026-10-20T15:00:00.000Z", // 10:00
    "2026-10-20T15:30:00.000Z", // 10:30
    "2026-10-20T16:00:00.000Z", // 11:00
    "2026-10-20T16:30:00.000Z", // 11:30
  ]);
});

// ── Subtracting what is taken ────────────────────────────────────────────────────────────

Deno.test("a booked meeting removes exactly its own slot", () => {
  const res = availableSlots({
    timeZone: TZ, weeklyHours: HOURS_9_TO_11, overrides: [],
    busy: [{ startsAt: "2026-10-20T14:30:00.000Z", endsAt: "2026-10-20T15:00:00.000Z" }],
    type: TYPE, fromDate: "2026-10-20", toDate: "2026-10-20", now: NOW,
  });
  assertEquals(starts(res, "2026-10-20"), [
    "2026-10-20T14:00:00.000Z",
    "2026-10-20T15:00:00.000Z",
    "2026-10-20T15:30:00.000Z",
  ]);
});

Deno.test("a slot that merely TOUCHES a busy window is still open", () => {
  // Back-to-back is legal when the type carries no buffers. Treating touch as overlap would
  // silently halve a busy host's availability.
  const res = availableSlots({
    timeZone: TZ, weeklyHours: HOURS_9_TO_11, overrides: [],
    busy: [{ startsAt: "2026-10-20T13:30:00.000Z", endsAt: "2026-10-20T14:00:00.000Z" }],
    type: TYPE, fromDate: "2026-10-20", toDate: "2026-10-20", now: NOW,
  });
  assert(starts(res, "2026-10-20").includes("2026-10-20T14:00:00.000Z"));
});

Deno.test("buffers widen the candidate, not just the booking", () => {
  // 15 minutes either side of a 09:30 booking blocks 09:00 (ends 09:30, needs 15 clear after)
  // and 10:00 (starts 15 after 10:00's buffer reaches back into the booking).
  const res = availableSlots({
    timeZone: TZ, weeklyHours: HOURS_9_TO_11, overrides: [],
    busy: [{ startsAt: "2026-10-20T14:30:00.000Z", endsAt: "2026-10-20T15:00:00.000Z" }],
    type: { ...TYPE, bufferBeforeMinutes: 15, bufferAfterMinutes: 15 },
    fromDate: "2026-10-20", toDate: "2026-10-20", now: NOW,
  });
  assertEquals(starts(res, "2026-10-20"), ["2026-10-20T15:30:00.000Z"]); // only 10:30 survives
});

Deno.test("widenBusy grows each window by its own type's buffers", () => {
  assertEquals(
    widenBusy([{
      startsAt: "2026-10-20T14:00:00.000Z",
      endsAt: "2026-10-20T14:30:00.000Z",
      bufferBeforeMinutes: 10,
      bufferAfterMinutes: 20,
    }]),
    [{ startsAt: "2026-10-20T13:50:00.000Z", endsAt: "2026-10-20T14:50:00.000Z" }],
  );
  // No buffers declared is not a crash and not NaN — it is the window itself.
  assertEquals(
    widenBusy([{ startsAt: "2026-10-20T14:00:00.000Z", endsAt: "2026-10-20T14:30:00.000Z" }]),
    [{ startsAt: "2026-10-20T14:00:00.000Z", endsAt: "2026-10-20T14:30:00.000Z" }],
  );
});

Deno.test("an external busy block is subtracted the same way a booking is", () => {
  // This is the whole value of phases 3-4: the host's dentist appointment is not in our
  // database, and the engine must not care where the window came from.
  const res = availableSlots({
    timeZone: TZ, weeklyHours: HOURS_9_TO_11, overrides: [],
    busy: [{ startsAt: "2026-10-20T14:00:00.000Z", endsAt: "2026-10-20T15:30:00.000Z" }],
    type: TYPE, fromDate: "2026-10-20", toDate: "2026-10-20", now: NOW,
  });
  assertEquals(starts(res, "2026-10-20"), ["2026-10-20T15:30:00.000Z"]);
});

// ── Notice and horizon ───────────────────────────────────────────────────────────────────

Deno.test("minimum notice hides the slots that are too soon", () => {
  // Now is 09:05 local (14:05Z). With 2 hours' notice the earliest bookable start is 11:05
  // local, and the day closes at 11:00 — so nothing is left.
  const res = availableSlots({
    timeZone: TZ, weeklyHours: HOURS_9_TO_11, overrides: [], busy: [],
    type: { ...TYPE, minNoticeHours: 2 },
    fromDate: "2026-10-20", toDate: "2026-10-20", now: new Date("2026-10-20T14:05:00Z"),
  });
  assertEquals(starts(res, "2026-10-20"), []);
});

Deno.test("max days ahead stops the horizon", () => {
  const res = availableSlots({
    timeZone: TZ, weeklyHours: HOURS_9_TO_11, overrides: [], busy: [],
    type: { ...TYPE, maxDaysAhead: 7 },
    fromDate: "2026-10-20", toDate: "2026-11-10", now: NOW,
  });
  // The Tuesday inside the window is open; the ones beyond it are not.
  assert(day(res, "2026-10-20").slots.length > 0);
  assertEquals(day(res, "2026-11-03").slots.length, 0);
  assertEquals(day(res, "2026-11-10").slots.length, 0);
});

// ── Overrides ────────────────────────────────────────────────────────────────────────────

Deno.test("a blocked date wins over the weekly hours", () => {
  const res = availableSlots({
    timeZone: TZ, weeklyHours: HOURS_9_TO_11,
    overrides: [{ onDate: "2026-10-20", blocked: true, hours: [] }],
    busy: [], type: TYPE, fromDate: "2026-10-20", toDate: "2026-10-20", now: NOW,
  });
  assertEquals(starts(res, "2026-10-20"), []);
});

Deno.test("an override REPLACES the day's hours and can shrink it", () => {
  // "I work 10-11 on the Tuesday before Thanksgiving" has to be able to narrow the day, which
  // is why hours replace rather than merge.
  const res = availableSlots({
    timeZone: TZ, weeklyHours: HOURS_9_TO_11,
    overrides: [{ onDate: "2026-10-20", blocked: false, hours: [["10:00", "11:00"]] }],
    busy: [], type: TYPE, fromDate: "2026-10-20", toDate: "2026-10-20", now: NOW,
  });
  assertEquals(starts(res, "2026-10-20"), [
    "2026-10-20T15:00:00.000Z",
    "2026-10-20T15:30:00.000Z",
  ]);
});

Deno.test("an override can OPEN a day the host does not normally work", () => {
  const res = availableSlots({
    timeZone: TZ, weeklyHours: HOURS_9_TO_11,
    overrides: [{ onDate: "2026-10-24", blocked: false, hours: [["09:00", "10:00"]] }],
    busy: [], type: TYPE, fromDate: "2026-10-24", toDate: "2026-10-24", now: NOW,
  });
  assertEquals(starts(res, "2026-10-24").length, 2); // a Saturday
});

// ── DST, end to end ──────────────────────────────────────────────────────────────────────

Deno.test("the clocks going forward does not shift the host's working day", () => {
  // Sunday 2026-03-08 is the transition. The host works 09:00-11:00 on Sundays here; those
  // are real wall-clock hours on both sides of it, and the offset has already changed by 09:00.
  const res = availableSlots({
    timeZone: TZ, weeklyHours: { sun: [["09:00", "11:00"]] }, overrides: [], busy: [],
    type: TYPE, fromDate: "2026-03-01", toDate: "2026-03-08",
    now: new Date("2026-02-01T00:00:00Z"),
  });
  // 1 March is CST (UTC-6): 09:00 local = 15:00Z.
  assertEquals(starts(res, "2026-03-01")[0], "2026-03-01T15:00:00.000Z");
  // 8 March is CDT (UTC-5): the same 09:00 local is 14:00Z. Same hours, different instant.
  assertEquals(starts(res, "2026-03-08")[0], "2026-03-08T14:00:00.000Z");
  assertEquals(starts(res, "2026-03-01").length, starts(res, "2026-03-08").length);
});

Deno.test("a working day that spans the spring-forward gap loses only the hour that does not exist", () => {
  // An overnight shift 01:00-05:00 on the transition day: 02:00-02:59 never happens, so those
  // two 30-minute slots must be absent while the rest of the day is untouched.
  const res = availableSlots({
    timeZone: TZ, weeklyHours: { sun: [["01:00", "05:00"]] }, overrides: [], busy: [],
    type: TYPE, fromDate: "2026-03-08", toDate: "2026-03-08",
    now: new Date("2026-02-01T00:00:00Z"),
  });
  const s = starts(res, "2026-03-08");
  // 01:00, 01:30, then 03:00, 03:30, 04:00, 04:30 — six, not eight.
  assertEquals(s.length, 6);
  assertEquals(s[0], "2026-03-08T07:00:00.000Z"); // 01:00 CST
  assertEquals(s[2], "2026-03-08T08:00:00.000Z"); // 03:00 CDT — one real hour after 01:30
});

Deno.test("the clocks going back does not duplicate a slot", () => {
  // 2026-11-01: 01:30 happens twice in local time. The engine must offer it ONCE — two
  // identical times on a booking page is the bug this case exists to prevent.
  const res = availableSlots({
    timeZone: TZ, weeklyHours: { sun: [["01:00", "05:00"]] }, overrides: [], busy: [],
    type: TYPE, fromDate: "2026-11-01", toDate: "2026-11-01",
    now: new Date("2026-10-01T00:00:00Z"),
  });
  const s = starts(res, "2026-11-01");
  assertEquals(new Set(s).size, s.length, "no duplicate instants");
  // Every offered start really is on the half hour.
  for (const iso of s) assert(/:(00|30):00\.000Z$/.test(iso), `${iso} is not on the grid`);
});

// ── Refusals ─────────────────────────────────────────────────────────────────────────────

Deno.test("malformed input yields nothing rather than throwing", () => {
  const base = {
    timeZone: TZ, weeklyHours: HOURS_9_TO_11, overrides: [], busy: [], type: TYPE, now: NOW,
  };
  assertEquals(availableSlots({ ...base, fromDate: "nope", toDate: "2026-10-20" }), []);
  assertEquals(availableSlots({ ...base, fromDate: "2026-10-20", toDate: "nope" }), []);
  // A backwards range is empty, not an infinite loop.
  assertEquals(availableSlots({ ...base, fromDate: "2026-10-20", toDate: "2026-10-19" }), []);
});

Deno.test("a malformed hours block is skipped, not fatal", () => {
  const res = availableSlots({
    timeZone: TZ,
    weeklyHours: { tue: [["09:00", "11:00"], ["25:00", "26:00"], ["11:00", "10:00"]] } as Record<string, [string, string][]>,
    overrides: [], busy: [], type: TYPE,
    fromDate: "2026-10-20", toDate: "2026-10-20", now: NOW,
  });
  assertEquals(starts(res, "2026-10-20").length, 4); // only the valid block produced slots
});

Deno.test("a long range is capped rather than served", () => {
  const res = availableSlots({
    timeZone: TZ, weeklyHours: HOURS_9_TO_11, overrides: [], busy: [], type: TYPE,
    fromDate: "2026-01-01", toDate: "2026-12-31", now: new Date("2026-01-01T00:00:00Z"),
  });
  assertEquals(res.length, MAX_RANGE_DAYS);
});
