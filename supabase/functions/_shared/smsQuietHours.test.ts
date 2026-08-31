import { assert, assertEquals } from "jsr:@std/assert@1";
import { quietHoursVerdict } from "./smsQuietHours.ts";

// A fixed January date (standard time, no DST) and a fixed July date (DST) so the tests
// pin both branches of isUsDst without depending on when they are run.
const JAN = (utcHour: number) => new Date(Date.UTC(2026, 0, 15, utcHour, 0, 0));
const JUL = (utcHour: number) => new Date(Date.UTC(2026, 6, 15, utcHour, 0, 0));

Deno.test("Eastern: 9am local is allowed", () => {
  // 14:00 UTC in January = 09:00 EST
  assert(quietHoursVerdict("212", JAN(14)).allowed);
});

Deno.test("Eastern: 2am local is refused", () => {
  // 07:00 UTC in January = 02:00 EST
  const v = quietHoursVerdict("212", JAN(7));
  assert(!v.allowed);
});

Deno.test("Eastern closes at 9pm, so 8:30pm is still allowed", () => {
  // 01:00 UTC = 20:00 EST the previous day
  assert(quietHoursVerdict("212", JAN(1)).allowed);
});

Deno.test("Florida closes an hour EARLIER than the federal floor", () => {
  // 01:00 UTC = 20:00 EST. Legal in NY, not in FL — the whole point of earlyClose.
  const ny = quietHoursVerdict("212", JAN(1));
  const fl = quietHoursVerdict("305", JAN(1));
  assert(ny.allowed, "8pm ET is inside New York's window");
  assert(!fl.allowed, "8pm ET is outside Florida's 8pm close");
});

Deno.test("Oklahoma (Central) and Washington (Pacific) also close early", () => {
  // 02:00 UTC = 20:00 CST in Oklahoma
  assert(!quietHoursVerdict("405", JAN(2)).allowed);
  // 04:00 UTC = 20:00 PST in Washington
  assert(!quietHoursVerdict("206", JAN(4)).allowed);
});

Deno.test("Pacific is offset from Eastern, not merged with it", () => {
  // 14:00 UTC = 09:00 EST (fine) but 06:00 PST (too early)
  assert(quietHoursVerdict("212", JAN(14)).allowed);
  assert(!quietHoursVerdict("415", JAN(14)).allowed);
});

Deno.test("Arizona does NOT observe daylight saving", () => {
  // 14:00 UTC in July: Pacific is UTC-7 (07:00, too early); Arizona is also UTC-7 all year.
  // The pair proves Arizona is treated as fixed rather than shifted with the rest of MST.
  const az = quietHoursVerdict("602", JUL(14));
  const mt = quietHoursVerdict("303", JUL(14)); // Denver, UTC-6 in July = 08:00, allowed
  assert(!az.allowed, "07:00 in Phoenix is before the window opens");
  assert(mt.allowed, "08:00 in Denver is exactly when it opens");
});

Deno.test("daylight saving actually shifts the window", () => {
  // 12:00 UTC: EST would be 07:00 (refused), EDT is 08:00 (allowed).
  assert(!quietHoursVerdict("212", JAN(12)).allowed);
  assert(quietHoursVerdict("212", JUL(12)).allowed);
});

Deno.test("Hawaii is UTC-10 and never shifts", () => {
  // 18:00 UTC = 08:00 HST, the moment it opens, in both January and July.
  assert(quietHoursVerdict("808", JAN(18)).allowed);
  assert(quietHoursVerdict("808", JUL(18)).allowed);
});

Deno.test("an UNKNOWN area code gets the strictest window, never a free pass", () => {
  // 555 is not assigned. 01:00 UTC = 20:00 ET, which the strict fallback refuses.
  const v = quietHoursVerdict("555", JAN(1));
  assert(!v.allowed, "unknown numbers must not be waved through at 8pm ET");
  assert(!v.allowed && /strictest window/.test(v.reason),
    "the refusal should say plainly that we could not place them");
});

Deno.test("a garbage or empty key still refuses rather than throwing", () => {
  assert(!quietHoursVerdict("", JAN(3)).allowed);
  assert(!quietHoursVerdict("xx", JAN(3)).allowed);
});

Deno.test("the refusal names a time the builder can act on", () => {
  const v = quietHoursVerdict("212", JAN(7)); // 02:00 EST
  assert(!v.allowed);
  if (!v.allowed) {
    assertEquals(v.localHour, 2);
    assert(/2am/.test(v.reason), "the message should say 2am, not a raw hour number");
    assert(/8am/.test(v.reason), "and should say when they CAN send");
  }
});
