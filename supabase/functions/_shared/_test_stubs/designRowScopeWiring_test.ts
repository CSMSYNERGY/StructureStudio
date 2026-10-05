// The design ROW SCOPE on portal-settings' designs:edit writes, pinned against the SHIPPED
// handler (2026-10-04).
//
// A Dealer holds designs:edit with contacts:'own' (access.ts). The gate answers "may you edit
// designs at all"; refuseUnlessDesignVisible answers "this one?", and a branch that forgets it
// does not fail — it RUNS, against a colleague's deal the caller cannot see in any list.
// set_expected_close (migration 206) shipped without it, so a dealer could move the close date
// on anybody's deal by posting its short code.
//
// Same technique as locationTaxWiring_test: read the source, so a drift fails the push. If an
// anchor moves, re-point it — do not delete the test.

import { assert } from "jsr:@std/assert@1";

const SETTINGS = await Deno.readTextFile(new URL("../../portal-settings/index.ts", import.meta.url));

/** Source with whole-line `//` comments removed, so a comment that NAMES the call cannot pass. */
const SRC = SETTINGS.replace(/\r\n/g, "\n").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

function branch(action: string): string {
  const start = `if (action === "${action}") {`;
  const i = SRC.indexOf(start);
  const j = i < 0 ? -1 : SRC.indexOf("\n  if (action ===", i + start.length);
  if (i < 0 || j < 0) {
    throw new Error(`designRowScopeWiring_test: could not find the ${action} branch (start=${i}, end=${j}). Re-point the anchors.`);
  }
  return SRC.slice(i, j);
}

Deno.test("set_expected_close checks the row scope before it writes", () => {
  const b = branch("set_expected_close");
  const scope = b.indexOf("refuseUnlessDesignVisible(shortCode)");
  const write = b.indexOf('admin.from("designs")');
  assert(scope >= 0, "set_expected_close no longer calls refuseUnlessDesignVisible — a Dealer can edit any deal's close date");
  assert(write >= 0, "set_expected_close's designs update moved — re-point this test");
  assert(scope < write, "the row scope runs after the write — the refusal would come too late");
});

Deno.test("every designs:edit branch that takes a shortCode checks the row scope", () => {
  // delete_design is role-gated (owner/admin) and is the one designs:edit write not listed.
  for (const action of ["set_expected_close", "set_design_sales_location", "link_design_to_unit", "resend_quote_email"]) {
    assert(branch(action).includes("refuseUnlessDesignVisible("), `${action} lost its row scope`);
  }
});
