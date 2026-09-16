// Unit tests for _shared/acceptTotal.ts — the accept race (2026-09-17).
//
// Deliberately dependency-free (no jsr:/npm: imports) so this suite still runs on a machine
// with no registry access — the same rule the other _shared tests follow.
//
// Two failures matter and both are silent: the check firing when the field is absent (every
// customer on production's older frontend is refused a signature), and the check passing a
// different total (a customer signs a number that is not the one on their screen).

import { checkExpectedTotal } from "./acceptTotal.ts";

const assertEquals = (a: unknown, b: unknown, msg?: string) => {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(msg ? `${msg}: ${sa} !== ${sb}` : `${sa} !== ${sb}`);
};

Deno.test("absent or null expectedTotalCents is today's behaviour: no check at all", () => {
  for (const total of [13316.38, 0, null]) {
    assertEquals(checkExpectedTotal(undefined, total), { ok: true }, `undefined vs ${total}`);
    assertEquals(checkExpectedTotal(null, total), { ok: true }, `null vs ${total}`);
  }
});

Deno.test("the total on screen is the total about to freeze: accepted, float dust included", () => {
  assertEquals(checkExpectedTotal(1331638, 13316.38), { ok: true });
  assertEquals(checkExpectedTotal(1122500, 11225), { ok: true });
  assertEquals(checkExpectedTotal(0, 0), { ok: true }, "a $0.00 quote is a total");
  // 0.1 + 0.2 style dust: the cents are compared, not the float.
  assertEquals(checkExpectedTotal(30, 0.1 + 0.2), { ok: true });
  assertEquals(checkExpectedTotal(90263, 902.625 + 0.005), { ok: true });
});

Deno.test("a re-priced quote is refused with 409 repriced and the current total", () => {
  assertEquals(checkExpectedTotal(1331638, 13390.1), {
    ok: false, status: 409,
    body: { error: "This quote was updated. Reload to see the current total before signing.", reason: "repriced", totalCents: 1339010 },
  });
  assertEquals(checkExpectedTotal(1331638, 13316.37).ok, false, "one cent is a different total");
  const gone = checkExpectedTotal(1331638, null);
  assertEquals([gone.ok, !gone.ok && gone.status, !gone.ok && gone.body], [false, 409, {
    error: "This quote was updated. Reload to see the current total before signing.", reason: "repriced", totalCents: null,
  }], "the page showed a total the quote no longer has");
});

Deno.test("a present value that is not whole cents is refused (400), never ignored", () => {
  for (const bad of ["1331638", 13316.38, NaN, Infinity, -Infinity, true, {}, [1331638], 2 ** 60]) {
    const r = checkExpectedTotal(bad, 13316.38);
    assertEquals([r.ok, !r.ok && r.status, !r.ok && r.body.reason], [false, 400, "bad_request"], JSON.stringify(bad));
  }
});
