// crm-rules-tick reads a queued message's rule at most ONCE (2026-11-06).
//
// Two sessions wrote the same fix the same day: a message held for the morning must not go out once
// its rule is paused, archived or deleted. The email-retries commit (48bd0f4c) owns it: a per-row
// read of crm_rules right after the claim, pinned by emailRetryWiring_test.ts ("a paused or removed
// rule sends nothing more"). Jack's branch dropped its own copy. This pins that a later merge keeps
// exactly one: two checks would read the rules twice per message and could disagree on the reason.
// It passes before that commit lands (no check yet) and after it (one).

import { assert } from "jsr:@std/assert@1";

const SRC = (await Deno.readTextFile(new URL("../../crm-rules-tick/index.ts", import.meta.url))).replace(/\r\n/g, "\n");
/** Without whole-line comments, so a comment naming the table can't count as a read. */
const CODE = SRC.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join("\n");

Deno.test("crm-rules-tick reads a queued message's rule at most once", () => {
  const reads = CODE.match(/from\("crm_rules"\)/g) ?? [];
  assert(reads.length <= 1, `crm-rules-tick reads crm_rules ${reads.length} times: keep one paused-rule check (emailRetryWiring_test.ts pins it)`);
});
