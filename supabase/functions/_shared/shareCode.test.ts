// The guessable-share-code test (2026-10-05), and that it says what migrations 156 and 193 say.
//
// The quote documents print the customer only for a code too long to enumerate. If this threshold
// and the SQL's ever disagree, one of them is redacting a customer the other hands out, so the
// migrations are read here and a drift fails the push.
//
// Codes are made up (the repo is public).

import { assert, assertEquals } from "jsr:@std/assert@1";
import { GUESSABLE_CODE_BELOW, shareCodeIsGuessable } from "./shareCode.ts";

Deno.test("shareCodeIsGuessable: the 48 legacy six-character codes, yes; today's ten, no", () => {
  assert(shareCodeIsGuessable("SS-ABC234"));
  assert(shareCodeIsGuessable("SS-ABC2345"));      // 7
  assert(!shareCodeIsGuessable("SS-ABC23456"));    // 8: one target, 2^40, not enumerable
  assert(!shareCodeIsGuessable("SS-ABCD2345EF"));  // 10, what genShortCode emits
  // The SQL strips only a leading "SS-", so this does too.
  assert(shareCodeIsGuessable("ABC2345"));
  assert(!shareCodeIsGuessable("ABCD2345EF"));
});

Deno.test("shareCodeIsGuessable: anything that is not a code reads as guessable (prints no customer)", () => {
  for (const v of [undefined, null, "", "SS-", 12345678901, {}, ["SS-ABCD2345EF"]]) {
    assert(shareCodeIsGuessable(v), JSON.stringify(v));
  }
});

Deno.test("the threshold is the one migrations 156 and 193 use", async () => {
  assertEquals(GUESSABLE_CODE_BELOW, 8);
  const dir = new URL("../../migrations/", import.meta.url);
  const want = /length\(regexp_replace\(\s*[a-z_.]*short_code,\s*'\^SS-',\s*''\s*\)\)\s*<\s*(\d+)/g;
  for (const prefix of ["156_", "193_design_version"]) {
    let name = "";
    for await (const e of Deno.readDir(dir)) if (e.name.startsWith(prefix) && e.name.endsWith(".sql")) name = e.name;
    assert(name, `no migration starting ${prefix}`);
    const sql = await Deno.readTextFile(new URL(name, dir));
    const found = [...sql.matchAll(want)].map((m) => Number(m[1]));
    assert(found.length > 0, `${name} no longer has the short-code test`);
    for (const n of found) assertEquals(n, GUESSABLE_CODE_BELOW, `${name} redacts below ${n}`);
  }
});
