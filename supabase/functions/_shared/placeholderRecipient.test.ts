// Unit tests for the placeholder-recipient check.
//
// WHY THESE EXIST. The invoice email retry skips the provider when this says true and tells
// the rep to fix the address, so a false positive stops a real customer's invoice email and a
// false negative puts the "(failed)" fault row back. Both directions are pinned: the reserved
// names and their subdomains match, and near-misses that are real, registrable domains do not.
//
// Run: deno test --node-modules-dir=none supabase/functions/_shared/placeholderRecipient.test.ts

import { isPlaceholderRecipient } from "./placeholderRecipient.ts";

function check(name: string, cond: boolean, detail?: string) {
  if (!cond) throw new Error(`${name}${detail ? `: ${detail}` : ""}`);
}

Deno.test("the RFC 2606 example domains are placeholders", () => {
  for (const e of ["a@example.com", "a@example.net", "a@example.org"]) {
    check(e, isPlaceholderRecipient(e) === true);
  }
});

Deno.test("subdomains of the example domains are placeholders", () => {
  for (const e of ["a@mail.example.org", "a@x.y.example.com"]) {
    check(e, isPlaceholderRecipient(e) === true);
  }
});

Deno.test("the reserved TLDs are placeholders", () => {
  for (const e of ["a@x.test", "a@y.invalid", "a@z.example", "a@host.localhost"]) {
    check(e, isPlaceholderRecipient(e) === true);
  }
});

Deno.test("case, surrounding whitespace and a trailing root dot are ignored", () => {
  for (const e of ["A@EXAMPLE.COM", "  a@Example.Org  ", "\ta@x.TEST\n", "a@example.com."]) {
    check(JSON.stringify(e), isPlaceholderRecipient(e) === true);
  }
});

Deno.test("real domains that only LOOK like the reserved ones are not placeholders", () => {
  for (
    const e of [
      "a@example.co",
      "a@examples.com",
      "a@myexample.com",
      "a@example.com.au",
      "a@gmail.com",
      "a@testing.com",
      "a@test.com",
      "a@invalid.org",
      "a@localhost.net",
    ]
  ) {
    check(e, isPlaceholderRecipient(e) === false);
  }
});

Deno.test("the local part never decides it", () => {
  check("example in local part", isPlaceholderRecipient("example.com@gmail.com") === false);
  check("test local part", isPlaceholderRecipient("test@gmail.com") === false);
});

Deno.test("non-addresses and non-strings are not placeholders", () => {
  for (const v of ["", "   ", "example.com", "a@", null, undefined, 42, {}]) {
    check(JSON.stringify(v) ?? String(v), isPlaceholderRecipient(v) === false);
  }
});
