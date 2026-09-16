// The tax chain's wiring in the two automatic paths, pinned against the SHIPPED handlers.
//
// taxChain.test.ts proves the decisions and salesTaxE2E_test proves the figures. Neither can see
// how the handlers call them, and the three mistakes that matter there are one short edit each,
// throw nothing, and pass every unit test:
//   1. flipping `allowLookup` on an automatic path — every submit or change order becomes a call
//      Avalara bills, with nobody having pressed anything;
//   2. wrapping submit-estimate's tax stamp in a conditional — a snapshot without `tax` falls
//      into totalFromSnapshot's pre-tax branch, and changeOrderDiff reads it as tax dropping to
//      $0.00, raising a change order the customer is asked to approve;
//   3. a charge on the change-order path that runs before its dry-run return — a preview that
//      can spend.
// Same technique as operatorMirror_test / electrical_test: read the source, so a drift fails the
// push instead of a copy going stale. If an anchor moves, re-point it — do not delete the test.

import { assert } from "jsr:@std/assert@1";

const SUBMIT = await Deno.readTextFile(new URL("../../submit-estimate/index.ts", import.meta.url));
const SETTINGS = await Deno.readTextFile(new URL("../../portal-settings/index.ts", import.meta.url));

/** Source with whole-line `//` comments removed, so a comment that NAMES a trap cannot trip it. */
const code = (src: string) => src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

function block(src: string, start: string, end: string, label: string): string {
  const i = src.indexOf(start);
  const j = i < 0 ? -1 : src.indexOf(end, i + start.length);
  if (i < 0 || j < 0) {
    throw new Error(`taxChainWiring_test: could not find the ${label} block (start=${i}, end=${j}). Re-point the anchors.`);
  }
  return code(src.slice(i, j));
}

Deno.test("submit-estimate: every resolveRate passes allowLookup false, and nothing passes true", () => {
  const src = code(SUBMIT);
  const calls = src.match(/resolveRate\([\s\S]*?\)\s*;/g) ?? [];
  assert(calls.length >= 1, "submit-estimate no longer calls resolveRate — re-point this test");
  for (const c of calls) assert(/allowLookup:\s*false/.test(c), `an automatic resolveRate without allowLookup false: ${c}`);
  assert(!/allowLookup:\s*true/.test(src), "submit-estimate passes allowLookup true — an automatic path would spend");
});

Deno.test("submit-estimate: the tax stamp is ONE unconditional assignment with a tax object on both arms", () => {
  const src = code(SUBMIT);
  assert(
    /\(estimateLines as Record<string, unknown>\)\.tax = resolved\s*\?\s*stampTax\(\{[\s\S]*?\}\)\s*:\s*carriedTax\(/.test(src),
    "the stamp is no longer `tax = resolved ? stampTax(...) : carriedTax(...)` — a branch that skips it drops the tax key",
  );
  const stamps = src.match(/\(estimateLines as Record<string, unknown>\)\.tax =/g) ?? [];
  assert(stamps.length === 1, `expected exactly one tax stamp in submit-estimate, found ${stamps.length}`);
});

Deno.test("change orders: no lookup, and the meter sits below the dry-run return and the design write", () => {
  const co = block(SETTINGS, 'if (action === "stage_order_attribute_change") {', "\n  if (action ===", "stage_order_attribute_change");
  const calls = co.match(/resolveRate\([\s\S]*?\)\s*;/g) ?? [];
  assert(calls.length >= 1, "the change-order path no longer calls resolveRate — re-point this test");
  for (const c of calls) assert(/allowLookup:\s*false/.test(c), `a change-order resolveRate without allowLookup false: ${c}`);
  assert(!/allowLookup:\s*true/.test(co), "the change-order path passes allowLookup true");

  const dry = co.indexOf("if (dryRun)");
  const write = co.indexOf('"apply the change", updErr');
  const charge = co.indexOf("chargeTaxCalculation(");
  assert(dry > 0 && write > 0, "could not find the dry-run return or the design write — re-point this test");
  assert(charge < 0 || (charge > dry && charge > write), "a tax charge runs before the dry-run return or before the design is written");
  assert(!/\|\|\s*0\s*,\s*\{\s*allowLookup/.test(co), "the change-order rate is back to a silent `|| 0`");
});
