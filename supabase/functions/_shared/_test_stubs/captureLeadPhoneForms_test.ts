// capture-lead matches a NANP phone in both of its spellings, tested against the SHIPPED
// source (2026-10-04).
//
// captured_leads is unique on the RAW digit run, so "+1 816 555 0100" (18165550100) and
// "816-555-0100" (8165550100) were two leads for one visitor: two Browsing rows in Contacts,
// and the debounce and the enrich-never-blank merge each judged against the wrong row. The
// lookup now asks for both NANP forms and the write lands on the matched row's own key. An
// international number keeps its exact match — collapsing it could fuse two different people.
//
// Same technique as captureLeadGuards_test: lift the real expressions between anchors and run
// them. If an anchor moves, re-point it — do not delete the test.

import { assert, assertEquals } from "jsr:@std/assert";

const SRC = (await Deno.readTextFile(new URL("../../capture-lead/index.ts", import.meta.url))).replace(/\r\n/g, "\n");

const line = (start: string) => {
  const i = SRC.indexOf(start);
  assert(i >= 0, `captureLeadPhoneForms_test: "${start}" not found in capture-lead/index.ts — re-point`);
  return SRC.slice(i, SRC.indexOf(";", i) + 1);
};
// `ten` carries a TypeScript annotation, which new Function cannot parse.
const TEN = line("const ten = ").replace(/:\s*string\b/g, "");
const NANP = line("const nanp = ");
const KEYS = line("const leadKeys = ");

const keysFor = new Function("phoneDigits", `${TEN}\nconst phoneKey10 = ten(phoneDigits);\n${NANP}\n${KEYS}\nreturn leadKeys;`) as (d: string) => string[];

Deno.test("a NANP number is looked up in both spellings, whichever one arrives", () => {
  assertEquals([...keysFor("8165550100")].sort(), ["18165550100", "8165550100"]);
  assertEquals([...keysFor("18165550100")].sort(), ["18165550100", "8165550100"]);
});

Deno.test("an international number keeps its exact match", () => {
  assertEquals(keysFor("441632960961"), ["441632960961"]);
  assertEquals(keysFor("28165550100"), ["28165550100"]);
});

Deno.test("the lookup uses those keys, and the write lands on the matched row's key", () => {
  assert(/from\("captured_leads"\)[\s\S]{0,300}\.in\("phone_digits", leadKeys\)/.test(SRC), "the lead lookup no longer asks for leadKeys");
  assert(/phone_digits: existingLead\?\.phone_digits \|\| phoneDigits/.test(SRC), "the upsert no longer reuses the matched row's phone_digits");
});
