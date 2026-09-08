// Unit tests for the ownership phone comparison.
//
// WHY THESE EXIST. This one function decides whether a stranger can read, sign, or PAY
// someone else's invoice. It was a private copy in two functions and would have been a
// third in customer-pay; extracting it is only safe if the behaviour is pinned, because a
// drift here fails in the direction nobody notices — a match that should not have matched.
//
// The formatted-string case is not hypothetical: a stored contact phone of
// "+1 (816) 555-0123" strips to 11 digits, which used to never match the session's 10 and
// refused verified customers their own quotes and their own signature.

import { phoneKey } from "./phoneKey.ts";

function check(name: string, cond: boolean, detail?: string) {
  if (!cond) throw new Error(`${name}${detail ? `: ${detail}` : ""}`);
}

Deno.test("a bare 10-digit number is itself", () => {
  check("plain", phoneKey("8163003600") === "8163003600");
});

Deno.test("exactly one leading US 1 is stripped from an 11-digit number", () => {
  check("11 with 1", phoneKey("18163003600") === "8163003600");
  check("E.164", phoneKey("+18163003600") === "8163003600");
});

Deno.test("formatted display strings normalise to the same key", () => {
  // The bug this function exists to fix.
  for (const s of ["+1 (816) 300-3600", "(816) 300-3600", "816-300-3600", "816.300.3600", " 816 300 3600 "]) {
    check(s, phoneKey(s) === "8163003600", `${s} -> ${phoneKey(s)}`);
  }
});

Deno.test("an 11-digit number NOT starting with 1 is left alone", () => {
  // Nothing looser than the one documented case: silently truncating a foreign number
  // would map it onto somebody else's key.
  check("44...", phoneKey("44161234567") === "44161234567");
});

Deno.test("longer international strings compare as-is", () => {
  check("12 digits", phoneKey("+44 161 234 5678") === "441612345678");
});

Deno.test("empty and junk collapse to an empty key, which can never match", () => {
  // Both call sites treat an empty key as a refusal — `if (!dPhone || dPhone !== ...)` —
  // so a design with no stored phone is never payable by anyone.
  check("empty", phoneKey("") === "");
  check("null", phoneKey(null) === "");
  check("undefined", phoneKey(undefined) === "");
  check("letters", phoneKey("not a phone") === "");
  check("object", phoneKey({} as unknown) === "");
});

Deno.test("two spellings of the same number are equal, and a different number is not", () => {
  check("equal", phoneKey("+1 (816) 300-3600") === phoneKey("8163003600"));
  check("not equal", phoneKey("8163003600") !== phoneKey("8163003601"));
  // The truncation bug the designer's formatter once had: dropping a digit must not match.
  check("dropped digit", phoneKey("816300360") !== phoneKey("8163003600"));
});
