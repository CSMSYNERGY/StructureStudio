// Deliberately dependency-free (no jsr:/npm: imports) so this suite still runs on a machine
// with no registry access — the same rule the other _shared tests follow.
import { numOrNull } from "./scheduleInput.ts";

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
