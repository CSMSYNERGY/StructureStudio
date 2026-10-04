// Deliberately dependency-free (no jsr:/npm: imports) so this suite still runs on a machine
// with no registry access — the same rule the other _shared tests follow.
import { calendarDayIn, isTimeZone, numOrNull } from "./scheduleInput.ts";

function assertEquals(actual: unknown, expected: unknown, msg?: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg ?? "assertEquals"}\n  actual:   ${a}\n  expected: ${e}`);
}

Deno.test("numOrNull: a cleared field is null, never 0", () => {
  // What the portal actually sends for an empty box — the case that used to become 0 and
  // trip driver_profiles' `> 0` CHECK.
  assertEquals(numOrNull(null), null, "null");
  assertEquals(numOrNull(""), null, "empty string");
  assertEquals(numOrNull("   "), null, "whitespace");
  assertEquals(numOrNull(undefined), null, "undefined");
});

Deno.test("numOrNull: real numbers survive, including a deliberate zero", () => {
  assertEquals(numOrNull(0), 0, "zero is a value (a no-charge repair)");
  assertEquals(numOrNull("0"), 0, "typed zero");
  assertEquals(numOrNull(40), 40);
  assertEquals(numOrNull("8.5"), 8.5);
  assertEquals(numOrNull(" 12 "), 12);
  assertEquals(numOrNull(-3), -3);
});

Deno.test("numOrNull: garbage is null", () => {
  assertEquals(numOrNull("abc"), null);
  assertEquals(numOrNull(NaN), null);
  assertEquals(numOrNull(Infinity), null);
  assertEquals(numOrNull(true), null, "a boolean is not a number field");
  assertEquals(numOrNull({}), null);
  assertEquals(numOrNull([]), null, "Number([]) is 0 — must not leak through");
});

Deno.test("calendarDayIn: an evening build is stamped with the shop's day, not UTC's", () => {
  // 7:30 pm CDT on Oct 4 is 00:30 UTC on Oct 5 — the old slice(0, 10) said Oct 5.
  const iso = "2026-10-05T00:30:00.000Z";
  assertEquals(calendarDayIn(iso, "America/Chicago"), "2026-10-04", "Central evening");
  assertEquals(calendarDayIn(iso, "America/Los_Angeles"), "2026-10-04", "Pacific");
  assertEquals(calendarDayIn(iso, "America/New_York"), "2026-10-04", "Eastern");
  assertEquals(calendarDayIn("2026-10-04T15:00:00.000Z", "America/Chicago"), "2026-10-04", "midday unchanged");
  // Postgres hands completed_at back with an offset, not a Z.
  assertEquals(calendarDayIn("2026-10-05T01:15:00+00:00", "America/Denver"), "2026-10-04", "offset form");
});

Deno.test("calendarDayIn: no or unknown zone keeps the UTC day (old behaviour)", () => {
  const iso = "2026-10-05T00:30:00.000Z";
  assertEquals(calendarDayIn(iso, null), "2026-10-05");
  assertEquals(calendarDayIn(iso, undefined), "2026-10-05");
  assertEquals(calendarDayIn(iso, "Not/AZone"), "2026-10-05");
  assertEquals(isTimeZone("America/Chicago"), true);
  assertEquals(isTimeZone("Not/AZone"), false);
  assertEquals(isTimeZone("x'; drop"), false);
});
